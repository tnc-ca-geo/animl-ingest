import Enum from 'enum';
import { rimraf } from 'rimraf';
import mime from 'mime-types';
import sharp from 'sharp';

import S3 from '@aws-sdk/client-s3';
import Batch from '@aws-sdk/client-batch';
import Lambda from '@aws-sdk/client-lambda';
import SSM from '@aws-sdk/client-ssm';

import time from 'strtime';
const strptime = time.strptime;

import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

const IN_MAINTENANCE_MODE = false;

const region = process.env.AWS_DEFAULT_REGION || 'us-west-2';

const IngestType = new Enum(['NONE', 'IMAGE', 'BATCH'], 'IngestType');

const APIKEY = process.env.APIKEY;

const SHARP_CONFIG = { failOn: 'none' };

export default class Task {
    constructor(stage = 'dev') {
        this.STAGE = stage;

        this.BATCH_FILE_TYPES = ['.zip'];
        this.SUPPORTED_FILE_TYPES = ['.jpg', '.png']; // If this is changed also update ingest-image

        this.EXIF_DATE_TIME_FORMAT = '%Y:%m:%d %H:%M:%S';
        this.IMG_SIZES = {
            original: null,
            medium: [940, 940],
            small: [120, 120]
        };

        this.SSM = new Map();
        this.SSM.set(`/api/url-${this.STAGE}`, 'ANIML_API_URL');
        this.SSM.set(`/api/exif-function-${this.STAGE}`, 'EXIF_FUNCTION');
        this.SSM.set(`/images/batch-queue-${this.STAGE}`, 'BATCH_QUEUE');
        this.SSM.set(`/images/batch-job-${this.STAGE}`, 'BATCH_JOB');
        this.SSM.set(`/images/serving-bucket-${this.STAGE}`, 'SERVING_BUCKET');
        this.SSM.set(`/images/dead-letter-bucket-${this.STAGE}`, 'DEADLETTER_BUCKET');
        this.SSM.set(`/images/parkinglot-bucket-${this.STAGE}`, 'PARKINGLOT_BUCKET');
        for (const ssm of this.SSM.values()) this[ssm] = null;

        this.tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnc-'));
    }

    static async control(stage, event) {
        const task = new Task(stage);

        try {
            await task.get_config();

            for (const record of event.Records) {

                const md = {
                    Bucket: record.s3.bucket.name,
                    // Key Decode: https://docs.aws.amazon.com/lambda/latest/dg/with-s3-tutorial.html
                    Key: decodeURIComponent(record.s3.object.key.replace(/\+/g, ' ')),
                    errors: []
                };
                console.log(`New file detected in ${md.Bucket}: ${md.Key}`);
                md.FileName = `${path.parse(md.Key).name}${path.parse(md.Key).ext.toLowerCase()}`;

                if (md.Key.match(/^batch-(\b[0-9a-f]{8}\b-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-\b[0-9a-f]{12}\b)/)) {
                    md.batchId = md.Key.match(/^batch-\b[0-9a-f]{8}\b-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-\b[0-9a-f]{12}\b/)[0];
                } else {
                    md.batchId = null;
                }

                const ingest_type = task.validate(md.FileName);

                if (ingest_type === IngestType.IMAGE) {
                    console.log('Processing as image upload');
                    await task.process_image(md);

                    console.log(`Deleting ${md.Key} from ${md.Bucket}`);
                    const s3 = new S3.S3Client({ region });
                    await s3.send(new S3.DeleteObjectCommand({
                        Bucket: md.Bucket,
                        Key: md.Key
                    }));
                } else if (ingest_type === IngestType.BATCH) {
                    console.log('Processing as batch upload');
                    await task.process_batch(md);
                } else {
                    console.log(`${md.FileName} is not a supported file type`);
                }
            }

            await rimraf(task.tmp_dir);
            task.tmp_dir = null;
        } catch (err) {
            console.error(err);
            if (task.tmp_dir) await rimraf(task.tmp_dir);
            throw err;
        }
    }

    async get_config() {
        const ssm = new SSM.SSMClient({ region });

        for (const param of (await ssm.send(new SSM.GetParametersCommand({
            Names: Array.from(this.SSM.keys()),
            WithDecryption: true
        }))).Parameters) {
            this[this.SSM.get(param.Name)] = param.Value;
        }
    }

    async process_image(md) {
        if (IN_MAINTENANCE_MODE) {
            console.log('IN_MAINTANCE_MODE detected, so copying images to parking lot bucket');
            await this.copy_to_parkinglot(md);
            return;
        }

        const tmp_path = await this.download(md);
        const exif_data = await this.get_exif_data(md);

        const mimetype = mime.lookup(tmp_path);
        md = await this.enrich_meta_data(md, exif_data, mimetype);

        try {
            await this.sharp_stats(md);
        } catch (err) {
            md.errors.push('Sharp could not open provided image');
        }

        await this.save_image(md);
    }

    async sharp_stats(md) {
        return await sharp(path.join(this.tmp_dir, md.FileName), SHARP_CONFIG).stats();
    }

    async save_image(md) {
        try {
            const imageAttempt = (await fetcher(this.ANIML_API_URL, {
                query: `
                    mutation CreateImageRecord($input: CreateImageInput!){
                        createImage(input: $input) {
                            imageAttempt {
                                _id
                                errors {
                                  _id
                                  error
                                }
                            }
                        }
                    }
                `,
                variables: {
                    input: {
                        md: md
                    }
                }
            })).data.createImage.imageAttempt;
            console.log(`createImage res: ${JSON.stringify(imageAttempt)}`);

            md._id = imageAttempt._id;
            const errors = imageAttempt.errors;

            if (errors.length) {
                let msg = (errors.length === 1) ? errors[0].error : 'MULTIPLE_ERRORS';
                if (msg.includes('E11000')) msg = 'DUPLICATE_IMAGE';
                const err = new Error(msg);
                await this.copy_to_dlb(err, md);
            } else {
                await this.copy_to_prod(md);
            }
        } catch (err) {
            // backstop for unforeseen errors returned by the API
            // and errors resizing/copying the image to prod buckets.
            // Controlled errors during image record creation are returned
            // to in the imageAttempt.errors payload and handled above

            console.error(`Error saving image: ${err}`);

            if (md._id) {
                await fetcher(this.ANIML_API_URL, {
                    query: `
                        mutation CreateImageError($input: CreateImageErrorInput!) {
                            createImageError(input: $input) {
                                _id
                                batch
                                error
                                created
                            }
                        }
                    `,
                    variables: {
                        input: {
                            error: err.message,
                            image: md._id,
                            path: md.path || md.fileName,
                            batch: md.batchId ? md.batchId : undefined
                        }
                    }
                });
            }

            await this.copy_to_dlb(err, md);
        }
    }

    async copy_to_dlb(err, md) {
        const Bucket = this.DEADLETTER_BUCKET;

        if (err.message.toLowerCase().includes('corrupt')) {
            err.message = 'CORRUPTED_IMAGE_FILE';
        }
        const Key = path.join((err.message || 'UNKNOWN_ERROR'), (md._id || 'UNKNOWN_ID'), path.parse(md.FileName).base);
        console.log(`Transferring image to s3://${Bucket}/${Key}`);

        const s3 = new S3.S3Client({ region });
        await s3.send(new S3.CopyObjectCommand({
            CopySource: `${md.Bucket}/${md.Key}`,
            ContentType: md.MIMEType,
            Bucket: Bucket,
            Key: Key
        }));
    }

    async copy_to_parkinglot(md) {
        const Bucket = this.PARKINGLOT_BUCKET;

        const Key = md.Key;
        console.log(`Transferring image to s3://${Bucket}/${Key}`);

        const s3 = new S3.S3Client({ region });
        await s3.send(new S3.CopyObjectCommand({
            CopySource: `${md.Bucket}/${md.Key}`,
            ContentType: md.MIMEType,
            Bucket: Bucket,
            Key: Key
        }));
    }

    async resize(md, filename, dims) {
        const tmp_path = path.join(this.tmp_dir, filename);
        await sharp(path.join(this.tmp_dir, md.FileName), SHARP_CONFIG)
            .resize(dims[0], dims[1], {
                fit: 'inside'
            })
            .toFile(tmp_path);

        return tmp_path;
    }

    async copy_to_prod(md) {
        const Bucket = md['ProdBucket'];
        const s3 = new S3.S3Client({ region });

        for (const size in this.IMG_SIZES) {
            // create filename and key
            const filename = `${md._id}-${size}.${md.FileTypeExtension}`;
            const Key = path.join(size, filename);
            console.log(`Transferring ${Key} to ${Bucket}`);

            if (this.IMG_SIZES[size]) {
                // resize locally then upload to s3
                const tmp_path = await this.resize(md, filename, this.IMG_SIZES[size]);
                // NOTE: S3 is not deferring to my attempts to manually set
                // Content Type for RidgeTec images. It only works for Buckeye images
                await s3.send(new S3.PutObjectCommand({
                    Body: fs.readFileSync(tmp_path),
                    Bucket: Bucket,
                    Key: Key,
                    ContentType: md['MIMEType']
                }));
            } else {
                // copy original image directly over from staging bucket
                await s3.send(new S3.CopyObjectCommand({
                    CopySource: `${md.Bucket}/${md.Key}`,
                    ContentType: md['MIMEType'],
                    Bucket: Bucket,
                    Key: Key
                }));
            }
        }
    }

    async get_exif_data(md) {
        const lambda = new Lambda.LambdaClient({ region });

        console.log(`Calling Exif Lambda: ${this.EXIF_FUNCTION}`);

        const data = await lambda.send(new Lambda.InvokeCommand({
            FunctionName: this.EXIF_FUNCTION,
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify({
                routeKey: 'GET /',
                queryStringParameters: {
                    bucket: md.Bucket,
                    key: md.Key
                }
            })
        }));

        return JSON.parse(JSON.parse(new TextDecoder().decode(data.Payload)).body);
    }

    convert_datetime_to_ISO(date_time_exif, format = this.EXIF_DATE_TIME_FORMAT) {
        const iso_date_time = strptime(date_time_exif, format);
        return iso_date_time.toISOString();
    }

    async enrich_meta_data(md, exif_data, mimetype) {
        for (const key in exif_data) {
            const keyp = key.replace(/^.*?:/, '');
            if (!md[keyp]) md[keyp] = exif_data[key];
        }

        const file_ext = path.parse(md.FileName).ext;
        md.FileTypeExtension = md.FileTypeExtension ? md.FileTypeExtension.toLowerCase() : file_ext;

        if (md.DateTimeOriginal) {
            md.DateTimeOriginal = this.convert_datetime_to_ISO(md.DateTimeOriginal);
        }

        md.MIMEType = md.MIMEType || mimetype || 'image/jpeg';
        md.SerialNumber = md.SerialNumber || 'unknown';
        md.ProdBucket = this.SERVING_BUCKET;
        md.Hash = await this.hash(md.FileName);
        md.ImageBytes = await this.byte_size(`${this.tmp_dir}/${md.FileName}`);
        md.Path = md.batchId ? md.Key.replace(md.batchId + '/', '') : null;

        return md;
    }

    async byte_size(file) {
        return (await fsp.stat(file)).size;
    }

    validate(file_name) {
        const ext = path.parse(file_name).ext.toLowerCase();

        if (this.SUPPORTED_FILE_TYPES.includes(ext)) {
            return IngestType.IMAGE;
        } else if (this.BATCH_FILE_TYPES.includes(ext)) {
            return IngestType.BATCH;
        } else {
            return IngestType.NONE;
        }
    }

    async hash(img_name) {
        return createHash('md5').update(await fsp.readFile(path.resolve(this.tmp_dir, img_name))).digest('hex');
    }

    async download(md) {
        console.log(`Downloading s3://${md.Bucket}/${md.Key}`);
        const tmp_path = `${this.tmp_dir}/${md.FileName}`;

        const s3 = new S3.S3Client({ region });
        await pipeline(
            (await s3.send(new S3.GetObjectCommand({
                Bucket: md.Bucket, Key: md.Key
            }))).Body,
            fs.createWriteStream(tmp_path)
        );

        return tmp_path;
    }

    async process_batch(md) {
        const batch = new Batch.BatchClient({ region });
        await batch.send(new Batch.SubmitJobCommand({
            jobName: 'process-batch',
            jobQueue: this.BATCH_QUEUE,
            jobDefinition: this.BATCH_JOB,
            containerOverrides: {
                environment: [{
                    name: 'TASK',
                    value: JSON.stringify(md)
                }]
            }
        }));
    }
}

async function fetcher(url, body) {
    console.log('Posting metadata to API', JSON.stringify(body));

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': APIKEY
        },
        body: JSON.stringify(body)
    });

    clearTimeout(id);

    if (!res.ok) {
        const texterr = await res.text();
        let jsonerr;
        try {
            jsonerr = JSON.parse(texterr);
        } catch (err) {
            throw new Error(texterr);
        }

        if (jsonerr.message) throw new Error(jsonerr.message);
        throw new Error(texterr);
    }

    const json = await res.json();

    if (json && Array.isArray(json.errors) && json.errors.length) {
        throw new Error(json.errors[0].message);
    }

    return json;
}

export async function handler(event) {
    console.log('EVENT:', event);
    await Task.control(process.env.STAGE, event);
}

if (import.meta.url === `file://${process.argv[1]}`) handler({ Records: [{
    s3: {
        bucket: {
            name: 'animl-images-ingestion-dev'
        },
        object: {
            key: 'test-5165373122.jpg'
        }
    }
}] });
