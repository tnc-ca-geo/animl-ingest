#!/opt/bin/perl

from PIL import Image, ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES = True
import boto3
import requests
import os
import sys
import uuid
import subprocess
import ntpath
from urllib.parse import unquote_plus
import json
import hashlib
import exiftool


ANIML_IMG_API = os.environ['API_URL']
ARCHIVE_BUCKET = 'animl-data-archive-{}'.format(os.environ['STAGE'])
PROD_BUCKET = 'animl-data-production-{}'.format(os.environ['STAGE'])
PROD_DIR_IMGS = 'images'
PROD_DIR_THUMB = 'thumbnails'
EXIFTOOL_PATH = '{}/exiftool'.format(os.environ['LAMBDA_TASK_ROOT'])
SUPPORTED_FILE_TYPES = ['.jpg', '.png']
THUMB_SIZE = (120, 120)
s3 = boto3.client('s3')


def make_request(exif_data):
    print('Making request')
    r = requests.post(ANIML_IMG_API, json=exif_data)
    print(r.status_code)
    # print(r.json())

def create_thumbnail(md, size=THUMB_SIZE, bkt=PROD_BUCKET, dir=PROD_DIR_THUMB):
    print('Creating thumbnail')
    file_ext = os.path.splitext(md['FileName'])
    thumb_filename = '{}-small{}'.format(md['Hash'], file_ext[1])
    tmp_path_thumb = os.path.join('/tmp', thumb_filename)
    with Image.open(md['SourceFile']) as image:
        image.thumbnail(size)
        image.save(tmp_path_thumb)
    print('Transferring {} to {}'.format(thumb_filename, bkt))
    thumb_key = os.path.join(dir, thumb_filename)
    s3.upload_file(tmp_path_thumb, bkt, thumb_key)

def copy_to_dest(md, archive_bkt=ARCHIVE_BUCKET, prod_bkt=PROD_BUCKET):
    copy_source = { 'Bucket': md['Bucket'], 'Key': md['Key'] }
    file_base, file_ext = os.path.splitext(md['FileName'])
    # transfer to archive
    print('Transferring {} to {}'.format(md['FileName'], archive_bkt))
    sn = 'unknown-camera'
    if 'SerialNumber' in md:
        sn = md['SerialNumber']
    archive_key = os.path.join(sn, file_base + '_' + md['Hash'] + file_ext)
    s3.copy(copy_source, archive_bkt, archive_key)
    # transfer to prod
    print('Transferring {} to {}'.format(md['FileName'], prod_bkt))
    prod_key = os.path.join(PROD_DIR_IMGS, md['Hash'] + file_ext)
    s3.copy(copy_source, prod_bkt, prod_key)

def hash(img_path):
    image = Image.open(img_path)
    img_hash = hashlib.md5(image.tobytes()).hexdigest()
    return img_hash

def parse_bec_comment_field(exif_data):
    """
    BuckEyeCams nest their serial numbers in its 'comment' field
    which is a long string, so we need to parse it
    """
    ret = {}
    comment = exif_data['Comment'].splitlines()
    for item in comment:
        if 'SN=' in item:
            ret['SerialNumber'] = item.split('=')[1]
        elif 'TEXT1=' in item:
            ret['text_1'] = item.split('=')[1]
        elif 'TEXT2=' in item:
            ret['text_2'] = item.split('=')[1]
    return ret

def enrich_meta_data(md, exif_data):
    if ('Make' in exif_data) and (exif_data['Make'] == 'BuckEyeCam'):
        comment_field = parse_bec_comment_field(exif_data)
        exif_data.update(comment_field)
    md['Hash'] = hash(exif_data['SourceFile'])
    exif_data.update(md)
    md = exif_data
    print('Metadata: {}'.format(md))
    return md

def get_exif_data(img_path):
    os.environ['PATH'] = '{}:{}/'.format(os.environ['PATH'], EXIFTOOL_PATH)
    with exiftool.ExifTool() as et:
        ret = {}
        exif_data = et.get_metadata(img_path)
        # remove 'group names' from keys/exif-tags
        for key, value in exif_data.items():
            new_key = key if (':' not in key) else key.split(':')[1]
            ret[new_key] = value
        return ret

def download(bucket, key):
    print('Downloading {}'.format(key))
    tmpkey = key.replace('/', '')
    tmpkey = tmpkey.replace(' ', '_')
    tmp_path = '/tmp/{}{}'.format(uuid.uuid4(), tmpkey)
    s3.download_file(bucket, key, tmp_path)
    return tmp_path

def validate(file_name):
    ext = os.path.splitext(file_name)
    if ext[1].lower() not in SUPPORTED_FILE_TYPES:
        return False
    return True

def handler(event, context):
    for record in event['Records']:
        md = {
          'Bucket': record['s3']['bucket']['name'],
          'Key': unquote_plus(record['s3']['object']['key']),
        }
        print('New file detected in {}: {}'.format(md['Bucket'], md['Key']))
        md['FileName'] = ntpath.basename(md['Key'])
        if validate(md['FileName']):
            tmp_path = download(md['Bucket'], md['Key'])
            exif_data = get_exif_data(tmp_path)
            md = enrich_meta_data(md, exif_data)
            copy_to_dest(md)
            create_thumbnail(md)
            make_request(md)
        else:
            print('{} is not a supported file type'.format(md['FileName']))
        print('Deleting {} from {}'.format(md['Key'], md['Bucket']))
        s3.delete_object(Bucket=md['Bucket'], Key=md['Key'])