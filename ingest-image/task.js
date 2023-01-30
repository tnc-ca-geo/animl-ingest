import AWS from 'aws-sdk';
import Enum from 'enum';
import { graphql, buildSchema } from 'graphql';
import { v4 as uuidv4 } from 'uuid';
import rimraf from 'rimraf';
import mime from 'mime-types';
import { strptime } from 'strtime';

import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

const region = process.env.AWS_DEFAULT_REGION || 'us-west-2';

const IngestType = new Enum(['NONE', 'IMAGE', 'BATCH'], 'IngestType');

/*
const QUERY = buildSchema(`
    mutation CreateImageRecord($input: CreateImageInput!){
        createImage(input: $input) {
            image {
                _id
            }
        }
    }
`);
*/

export default class Task {
    constructor(stage = 'dev') {
        this.STAGE = stage;

        this.BATCH_FILE_TYPES = ['.zip'];
        this.SUPPORTED_FILE_TYPES = ['.jpg', '.png'];

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
        this.SSM.set(`/images/archive-bucket-${this.STAGE}`, 'ARCHIVE_BUCKET');
        this.SSM.set(`/images/serving-bucket-${this.STAGE}`, 'SERVING_BUCKET');
        this.SSM.set(`/images/dead-letter-bucket-${this.STAGE}`, 'DEADLETTER_BUCKET');
        for (const ssm of this.SSM.values()) this[ssm] = null;

        this.tmp_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnc-'));
    }

    static async control(stage, event) {
        try {
            const task = new Task(stage);
            await task.get_config();

            for (const record of event.Records) {
                const md = {
                    Bucket: record.s3.bucket.name,
                    // Key Decode: https://docs.aws.amazon.com/lambda/latest/dg/with-s3-tutorial.html
                    Key: decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '))
                };
                console.log(`New file detected in ${md.Bucket}: ${md.Key}`);
                md.FileName = `${path.parse(md.Key).name}${path.parse(md.Key).ext.toLowerCase()}`;

                const ingest_type = this.validate(md.FileName);

                if (ingest_type === IngestType.IMAGE) {
                    this.process_image(md);

                    console.log(`Deleting ${md.Key} from ${md.Bucket}`);

                    const s3 = new AWS.S3({ region });
                    await s3.deleteObject({
                        Bucket: md.Bucket,
                        Key: md.Key
                    }).promise();

                } else if (ingest_type === IngestType.BATCH) {
                    this.process_batch(md);
                } else {
                    console.log(`${md.FileName} is not a supported file type`);
                }
            }

            await rimraf(this.tmp_dir);
            this.tmp_dir = null;
        } catch (err) {
            if (this.tmp_dir) await rimraf(this.tmp_dir);
            throw err;
        }
    }

    async get_config() {
        const ssm = new AWS.SSM({ region });

        for (const param of (await ssm.getParameters({
            Names: Array.from(this.SSM.keys()),
            WithDecryption: true
        }).promise()).Parameters) {
            this[this.SSM.get(param.Name)] = param.Value;
        }
    }

    async process_image(md) {
        const tmp_path = await this.download(md.Bucket, md.Key);
        const exif_data = await this.get_exif_data(md);

        const mimetype = mime.lookup(tmp_path);
        md = this.enrich_meta_data(md, exif_data, mimetype);
        this.save_image(md);
    }

    async save_image(md) {

    }

    async get_exif_data(md) {
        // TODO Call to Exif Stack
        const lambda = new AWS.Lambda({ region });

        const exif = await lambda.invoke({
            FunctionName: this.EXIF_FUNCTION,
            Payload: JSON.stringify({
                routeKey: 'GET /',
                queryStringParameters: {
                    bucket: md.Bucket,
                    key: md.Key
                }
            });
        }).promise();

        console.error(exif);
    }

    convert_datetime_to_ISO(date_time_exif, format = EXIF_DATE_TIME_FORMAT) {
        const iso_date_time = strptime(date_time_exif, format);
        return iso_date_time.toISOString();
    }

    enrich_meta_data(md, exif_data, mimetype) {
        Object.assign(md, exif_data);

        file_ext = path.parse(md.FileName).ext;
        md.FileTypeExtension = md.FileTypeExtension.toLowerCase() || file_ext;
        md.DateTimeOriginal = this.convert_datetime_to_ISO(md.DateTimeOriginal);
        md.MIMEType = md.MIMEType || mimetype || 'image/jpeg';
        md.SerialNumber = md.SerialNumber || 'unknown';
        md.ArchiveBucket = this.ARCHIVE_BUCKET;
        md.ProdBucket = this.SERVING_BUCKET;
        md.Hash = this.hash(md.SourceFile);
        return md;
    }

    validate(file_name) {
        const ext = path.parse(file_name).ext;

        if (this.SUPPORTED_FILE_TYPES.includes(ext)) {
            return IngestType.IMAGE;
        } else if (this.BATCH_FILE_TYPES) {
            return IngestType.BATCH;
        } else {
            return IngestType.NONE;
        }
    }

    async hash(img_path) {
        return createHash('md5').update(await fsp.readFile(img_path)).digest('hex');
    }

    async download(Bucket, Key) {
        console.log(`Downloading ${Key}`);
        const tmpkey = Key.replace('/', '').replace(' ', '_');
        const tmp_path = `${this.tmp_dir}/${uuidv4()}/${tmpkey}`;

        const s3 = new AWS.S3({ region });
        await pipeline(
            s3.getObject({
                Bucket, Key
            }).createReadStream(),
            fs.createWriteStream(tmp_path)
        );

        return tmp_path;
    }

    async process_batch(md) {
        const batch = new AWS.Batch({ region });
        await batch.submitJob({
            jobName: 'process-batch',
            jobQueue: this.BAtCH_QUEUE,
            jobDefinition: this.BATCH_JOB,
            containerOverrides: {
                environment: [{
                    name: 'TASK',
                    value: JSON.stringify(md)
                }]
            }
        }).promise();
    }
}

export async function handler(event) {
    console.log('EVENT:', event);
    await Task.control(process.env.STAGE, event);
}

if (import.meta.url === `file://${process.argv[1]}`) handler({ Records: [] });

/**
import shutil
import ntpath
import tempfile
from urllib.parse import unquote_plus
from datetime import datetime
from PIL import Image, ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES = True
import boto3
from enum import Enum
from gql import Client, gql
from gql.transport.requests import RequestsHTTPTransport
import exiftool
from lambda_cache import ssm




def resize(tmp_dir, md, filename, dims):
    tmp_path = os.path.join(tmp_dir, filename)
    with Image.open(md["SourceFile"]) as image:
        image.thumbnail(dims)
        image.save(tmp_path)
    return tmp_path

def copy_to_dlb(errors, md, config):
    dl_bkt = config["DEADLETTER_BUCKET"]
    copy_source = { "Bucket": md["Bucket"], "Key": md["Key"] }
    dest_dir = "UNKNOWN_ERROR"
    for error in errors:
        if "extensions" in error and "code" in error["extensions"]:
            dest_dir = error["extensions"]["code"]
    dlb_key = os.path.join(dest_dir, md["FileName"])
    print("Transferring {} to {}".format(dlb_key, dl_bkt))
    s3.copy_object(
        CopySource=copy_source,
        ContentType=md["MIMEType"],
        Bucket=dl_bkt,
        Key=dlb_key,
    )

def copy_to_archive(md):
    archive_bkt = md["ArchiveBucket"]
    copy_source = { "Bucket": md["Bucket"], "Key": md["Key"] }
    file_base, file_ext = os.path.splitext(md["FileName"])
    archive_filename = file_base + "_" + md["Hash"] + file_ext
    archive_key = os.path.join(md["SerialNumber"], archive_filename)
    print("Transferring {} to {}".format(archive_key, archive_bkt))
    s3.copy_object(
        CopySource=copy_source,
        ContentType=md["MIMEType"],
        Bucket=archive_bkt,
        Key=archive_key,
    )
    return md

def copy_to_prod(tmp_dir, md, sizes=IMG_SIZES):
    prod_bkt = md["ProdBucket"]
    for size, dims in sizes.items():
        # create filename and key
        filename = "{}-{}.{}".format(md["Hash"], size, md["FileTypeExtension"])
        prod_key = os.path.join(size, filename)
        print("Transferring {} to {}".format(prod_key, prod_bkt))
        if dims is not None:
            # resize locally then upload to s3
            tmp_path = resize(tmp_dir, md, filename, dims)
            # NOTE: S3 is not deferring to my attempts to manually set
            # Content Type for RidgeTec images. It only works for Buckeye images
            s3.upload_file(
                tmp_path,
                prod_bkt,
                prod_key,
                ExtraArgs={"ContentType": md["MIMEType"]}
            )
        else:
            # copy original image directly over from staging bucket
            copy_source = { "Bucket": md["Bucket"], "Key": md["Key"] }
            s3.copy_object(
                CopySource=copy_source,
                ContentType=md["MIMEType"],
                Bucket=prod_bkt,
                Key=prod_key,
            )

def save_image(tmp_dir, md, config, query=QUERY):
    print("Posting metadata to API: {}".format(md))
    url = config["ANIML_API_URL"]
    image_input = {"input": { "md": md }}
    headers = {
        "x-api-key": os.environ["APIKEY"]
    }
    transport = RequestsHTTPTransport(
        url, verify=True, retries=3, headers=headers
    )
    client = Client(transport=transport, fetch_schema_from_transport=True)
    try:
        r = client.execute(query, variable_values=image_input)
        print("Response: {}".format(r))
        copy_to_prod(tmp_dir, md)
        copy_to_archive(md)
    except Exception as e:
        print("Error saving image: {}".format(e))
        errors = vars(e).get("errors", [])
        copy_to_dlb(errors, md, config)

*/
