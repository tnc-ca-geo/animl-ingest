#!/opt/bin/perl

import os
import uuid
import ntpath
from urllib.parse import unquote_plus
import hashlib
from PIL import Image, ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES = True
import boto3
from gql import Client, gql
from gql.transport.requests import RequestsHTTPTransport
import exiftool
from lambda_cache import ssm

EXIFTOOL_PATH = "{}/exiftool".format(os.environ["LAMBDA_TASK_ROOT"])
SUPPORTED_FILE_TYPES = [".jpg", ".png"]
IMG_SIZES = {
    "original": None,
    "medium": (940, 940),
    "small": (120, 120)
}
SSM_NAMES = {
    "ANIML_API_URL": "/api/url-{}".format(os.environ["STAGE"]),
    "ARCHIVE_BUCKET": "/images/archive-bucket-{}".format(os.environ["STAGE"]),
    "SERVING_BUCKET": "/images/serving-bucket-{}".format(os.environ["STAGE"]),
    "DEADLETTER_BUCKET": "/images/dead-letter-bucket-{}".format(os.environ["STAGE"]),
}
QUERY = gql("""
    mutation CreateImageRecord($input: CreateImageInput!){
        createImage(input: $input) {
            image {
                _id
            }
        }
    }
"""
)

s3 = boto3.client("s3")

def resize(md, filename, dims):
    tmp_path = os.path.join("/tmp", filename)
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
    s3.copy(copy_source, dl_bkt, dlb_key)

def copy_to_archive(md):
    archive_bkt = md["ArchiveBucket"]
    copy_source = { "Bucket": md["Bucket"], "Key": md["Key"] }
    file_base, file_ext = os.path.splitext(md["FileName"])
    archive_filename = file_base + "_" + md["Hash"] + file_ext
    archive_key = os.path.join(md["SerialNumber"], archive_filename)
    print("Transferring {} to {}".format(archive_key, archive_bkt))
    s3.copy(copy_source, archive_bkt, archive_key)
    return md

def copy_to_prod(md, sizes=IMG_SIZES):
    prod_bkt = md["ProdBucket"]
    for size, dims in sizes.items():
        # create filename and key
        filename = "{}-{}.{}".format(md["Hash"], size, md["FileTypeExtension"])
        prod_key = os.path.join(size, filename)
        print("Transferring {} to {}".format(prod_key, prod_bkt))
        if dims is not None:
            # resize locally then upload to s3
            tmp_path = resize(md, filename, dims)
            s3.upload_file(tmp_path, prod_bkt, prod_key)
        else:
            # copy original image directly over from staging bucket 
            copy_source = { "Bucket": md["Bucket"], "Key": md["Key"] }
            s3.copy(copy_source, prod_bkt, prod_key)

def save_image(md, config, query=QUERY):
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
        copy_to_prod(md)
        copy_to_archive(md)
    except Exception as e:
        print("Error saving image: {}".format(e))
        errors = vars(e).get("errors", [])
        copy_to_dlb(errors, md, config)

def hash(img_path):
    image = Image.open(img_path)
    img_hash = hashlib.md5(image.tobytes()).hexdigest()
    return img_hash

def enrich_meta_data(md, exif_data, config):
    exif_data.update(md)
    md = exif_data
    file_ext = os.path.splitext(md["FileName"])[1].lower().replace(".", "")
    md["FileTypeExtension"] = md["FileTypeExtension"].lower() or file_ext
    md["SerialNumber"] = md.get("SerialNumber") or "unknown"
    md["ArchiveBucket"] = config["ARCHIVE_BUCKET"]
    md["ProdBucket"] = config["SERVING_BUCKET"]
    md["Hash"] = hash(md["SourceFile"])
    return md

def get_exif_data(img_path):
    os.environ["PATH"] = "{}:{}/".format(os.environ["PATH"], EXIFTOOL_PATH)
    with exiftool.ExifTool() as et:
        ret = {}
        exif_data = et.get_metadata(img_path)
        # remove "group names" from keys/exif-tags
        for key, value in exif_data.items():
            # print("exif key: {}, value: {}".format(key, value))
            new_key = key if (":" not in key) else key.split(":")[1]
            ret[new_key] = value
        return ret

def download(bucket, key):
    print("Downloading {}".format(key))
    tmpkey = key.replace("/", "")
    tmpkey = tmpkey.replace(" ", "_")
    tmp_path = "/tmp/{}{}".format(uuid.uuid4(), tmpkey)
    s3.download_file(bucket, key, tmp_path)
    return tmp_path

def process_image(md, config):
    tmp_path = download(md["Bucket"], md["Key"])
    exif_data = get_exif_data(tmp_path)
    md = enrich_meta_data(md, exif_data, config)
    save_image(md, config)

def validate(file_name):
    ext = os.path.splitext(file_name)
    if ext[1].lower() not in SUPPORTED_FILE_TYPES:
        return False
    return True

def normalize(file_name):
    (root, ext) = os.path.splitext(file_name)
    return root + ext.lower()

def getConfig(context, ssm_names=SSM_NAMES):
    ret = {}
    for key, value in ssm_names.items():
        try:
            param_name = value.split("/")[-1]
            ret[key] = getattr(context,"config").get(param_name)
            if ret[key] is None:
                raise ValueError(value)
        except ValueError as err:
            print("SSM name '{}' was not found".format(err))
        except:
            print("An error occured fetching remote config")
    return ret

@ssm.cache(
  parameter=[value for _, value in SSM_NAMES.items()],
  entry_name="config",
  max_age_in_seconds=300
)
def handler(event, context):
    print("event: {}".format(event))
    config = getConfig(context)
    for record in event["Records"]:
        md = {
          "Bucket": record["s3"]["bucket"]["name"],
          "Key": unquote_plus(record["s3"]["object"]["key"]),
        }
        print("New file detected in {}: {}".format(md["Bucket"], md["Key"]))
        md["FileName"] = normalize(ntpath.basename(md["Key"]))
        if validate(md["FileName"]):
          process_image(md, config)
        else:
            print("{} is not a supported file type".format(md["FileName"]))
        print("Deleting {} from {}".format(md["Key"], md["Bucket"]))
        s3.delete_object(Bucket=md["Bucket"], Key=md["Key"])