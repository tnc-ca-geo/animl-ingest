import AWS from 'aws-sdk';
import Enum from 'enum';
import { graphql, buildSchema } from 'graphql';
import { v4 as uuidv4 } from 'uuid';
import rimraf from 'rimraf';

import path from 'node:path';
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';

const region = process.env.AWS_DEFAULT_REGION || 'us-west-2';

const S3 = new AWS.S3({ region });
const batch = new AWS.Batch({ region });
const ssm = new AWS.SSM({ region });

const IngestType = new Enum(['NONE', 'IMAGE', 'BATCH'], 'IngestType');

const EXIF_DATE_TIME_FORMAT = '%Y:%m:%d %H:%M:%S';
const IMG_SIZES = {
    original: null,
    medium: [940, 940],
    small: [120, 120]
};

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
    constructor(stage='dev') {
        this.STAGE = stage;

        this.BATCH_FILE_TYPES = ['.zip'];
        this.SUPPORTED_FILE_TYPES = ['.jpg', '.png'];
        this.SSM = new Map();
        this.SSM.set(`/api/url-${this.STAGE}`, 'ANIML_API_URL');
        this.SSM.set(`/images/batch-queue-${this.STAGE}`, 'BATCH_QUEUE');
        this.SSM.set(`/images/batch-job-${this.STAGE}`, 'BATCH_JOB');
        this.SSM.set(`/images/archive-bucket-${this.STAGE}`, 'ARCHIVE_BUCKET');
        this.SSM.set(`/images/serving-bucket-${this.STAGE}`, 'SERVING_BUCKET');
        this.SSM.set(`/images/dead-letter-bucket-${this.STAGE}`, 'DEADLETTER_BUCKET');
        for (const ssm of this.SSM.values()) this[ssm] = null;

        this.tmp_dir = fs.mkdtempSync('tnc');
    }

    static async control(stage, event) {
        try {
            const task = new Task(stage);
            await task.get_config();

            for (const record of event.Records) {
                const md = {
                    Bucket: record.s3.bucket.name,
                    // Key Decode: https://docs.aws.amazon.com/lambda/latest/dg/with-s3-tutorial.html
                    Key: decodeURIComponent(record.s3.object.key.replace(/\+/g, " ")),
                };
                console.log(`New file detected in ${md.Bucket}: ${md.Key}`);
                md.FileName = `${path.parse(md.Key).name}${path.parse(md.Key).ext.toLowerCase()}`;

                const ingest_type = this.validate(md.FileName);

                if (ingest_type === IngestType.IMAGE) {

                } else if (ingest_type === IngestType.BATCH) {

                } else {
                    console.log(`${md.FileName} is not a supported file type`);
                }
            }
        } catch (err) {
            if (this.tmp_dir) await rimraf(this.tmp_dir);
            throw err;
        }
    }

    async get_config() {
        for (const param of (await ssm.getParameters({
            Names: Array.from(this.SSM.keys()),
            WithDecryption: true
        }).promise()).Parameters) {
            this[this.SSM.get(param.Name)] = param.Value
        }
    }

    validate(file_name) {
        const ext = path.parse(file_name).ext;

        if (this.SUPPORTED_FILE_TYPES.includes(ext)) {
            return IngestType.IMAGE
        } else if (this.BATCH_FILE_TYPES) {
            return IngestType.BATCH
        } else {
            return IngestType.NONE
        }
    }

    async hash(img_path) {
        return createHash('md5').update(await fsp.readFile(img_path)).digest('hex');
    }

    async download(Bucket, Key) {
        console.log(`Downloading ${Key}`);
        const tmpkey = Key.replace('/', '').replace(' ', '_');
        const tmp_path = `${this.tmp_dir}/${uuidv4()}/${tmpkey}`;

        await pipeline(
            s3.getObject({
                Bucket, Key
            }).createReadStream(),
            fs.createWriteStream(tmp_path)
        );

        return tmp_path;
    }

    async process_batch(md, config) {
        await batch.submitJob({
            jobName: 'process-batch',
            jobQueue: config.BAtCH_QUEUE,
            jobDefinition: config.BATCH_JOB,
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
     console.log('EVENT:', event)
     await Task.control(process.env.STAGE, event);
}

if (import.meta.url === `file://${process.argv[1]}`) handler({ Records: [] });

/**
import shutil
import ntpath
import tempfile
import mimetypes
from urllib.parse import unquote_plus
from datetime import datetime
import hashlib
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

def convert_datetime_to_ISO(date_time_exif, format=EXIF_DATE_TIME_FORMAT):
    iso_date_time = datetime.strptime(date_time_exif, format).isoformat()
    return iso_date_time

def enrich_meta_data(md, exif_data, mimetype, config):
    exif_data.update(md)
    md = exif_data
    file_ext = os.path.splitext(md["FileName"])[1].lower().replace(".", "")
    md["FileTypeExtension"] = md["FileTypeExtension"].lower() or file_ext
    md["DateTimeOriginal"] = convert_datetime_to_ISO(md["DateTimeOriginal"])
    md["MIMEType"] = md["MIMEType"] or mimetype or "image/jpeg"
    md["SerialNumber"] = str(md.get("SerialNumber")) or "unknown"
    md["ArchiveBucket"] = config["ARCHIVE_BUCKET"]
    md["ProdBucket"] = config["SERVING_BUCKET"]
    md["Hash"] = hash(md["SourceFile"])
    return md

def get_exif_data(img_path):
    os.environ["PATH"] = "{}:{}/".format(os.environ["PATH"], EXIFTOOL_PATH)
    with exiftool.ExifToolHelper() as et:
        ret = {}
        for d in et.get_metadata(img_path):
            for k, v in d.items():
                new_key = k if (":" not in k) else k.split(":")[1]
                ret[new_key] = v
        return ret

def process_image(tmp_dir, md, config):
    tmp_path = download(tmp_dir, md["Bucket"], md["Key"])
    mimetype, _ = mimetypes.guess_type(tmp_path)
    exif_data = get_exif_data(tmp_path)
    md = enrich_meta_data(md, exif_data, mimetype, config)
    save_image(tmp_dir, md, config)

@ssm.cache(
  parameter=[value for _, value in SSM_NAMES.items()],
  entry_name="config",
  max_age_in_seconds=300
)
def handler(event, context):
        if ingest_type == IngestType.IMAGE:
            process_image(tmp_dir, md, config)

            print("Deleting {} from {}".format(md["Key"], md["Bucket"]))
            s3.delete_object(Bucket=md["Bucket"], Key=md["Key"])
        elif ingest_type == IngestType.BATCH:
            process_batch(md, config)
*/
