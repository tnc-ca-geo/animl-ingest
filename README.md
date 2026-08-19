# Animl Ingest

Lambda function for ingesting and processing camera trap images.

## About

The animl-ingest stack is a collection of AWS resources managed by the [Serverless framework](https://www.serverless.com/). When users or applications such as [animl-base](http://github.com/tnc-ca-geo/animl-base) upload images (or .zip files of images) to the `animl-staging-<stage>` bucket, one or more Lambda functions are fired and perform the following:

- if a .zip file is detected (i.e. a user initiated a bulk upload from the animl-frontend user interface), the file is unzipped, the contents are validated, ML processing resources are dynamically spun up to process the batch, and the images are copied into the ingestion bucket
- when new images are detected in the ingestion bucket, a separate lamnda (ingest-image) fires, which:
- extracts EXIF metadata
- creats a thumbnail of the image
- stores the thumbnail and the original in buckets for production
  access
- passes along the metadata in a POST request to a graphQL server to create a record of the image metadata in a database
- deletes the image from the staging bucket

## Setup

### Prerequisits

The instructions below assume you have the following tools globally installed:

- Serverless
- Docker
- aws-cli

### Create "animl" AWS config profile

The name of the profile must be "animl", because that's what
`serverles.yml` will be looking for. Good instructions
[here](https://www.serverless.com/framework/docs/providers/aws/guide/credentials/).

### Make a project direcory and clone this repo

```sh
git clone https://github.com/tnc-ca-geo/animl-ingest.git
cd animl-ingest
npm install
```

IMPORTANT NOTE: Sharp, one of the dependencies that's essential for opening image files and performing inference, may have issues once deployed to Lambda. See [this GitHub Issue](https://github.com/lovell/sharp/issues/4001) and their [documentation](https://sharp.pixelplumbing.com/install#aws-lambda) for more info on deploying Sharp to Lambda, but in short, unless your `node_modules/@img` directory has the following binaries, the inference Lambda will throw errors indicating it can't open Sharp:

```
sharp-darwin-arm64
sharp-libvips-darwin-arm64
sharp-libvips-linux-x64
sharp-libvips-linuxmusl-x64
sharp-linux-x64
sharp-linuxmusl-x64
```

Running the following may help install the additional necessary binaries if they are not present, but it seems a bit inconsistent:

```
npm install --os=linux --cpu=x64 sharp
```

## Dev deployment

From project root folder (where `serverless.yml` lives), run the following to deploy or update the stack:

```
# Deploy or update a development stack:
serverless deploy --stage dev
```

## Prod deployment

```
# Deploy or update a production stack:
serverless deploy --stage prod
```

Use caution when deploying to production, as the application involves multiple stacks (animl-ingest, animl-api, animl-frontend), and often the deployments need to be synchronized. For major deployments to prod in which there are breaking changes that affect the other components of the stack, follow these steps:

1. Set the frontend `IN_MAINTENANCE_MODE` to `true` (in `animl-frontend/src/config.js`), deploy to prod, then invalidate its cloudfront cache. This will temporarily prevent users from interacting with the frontend (editing labels, bulk uploading images, etc.) while the rest of the updates are being deployed.

2. Manually check batch logs and the DB to make sure there aren't any fresh uploads that are in progress but haven't yet been fully unzipped. In the DB, those batches would have a `created`: <date_time> property but wouldn't yet have `uploadComplete` or `processingStart` or `ingestionComplete` fields. See this issue more info: https://github.com/tnc-ca-geo/animl-api/issues/186

3. Set ingest-image's `IN_MAINTENANCE_MODE` to `true` (in `animl-ingest/ingest-image/task.js`) and deploy to prod. While in maintenance mode, any images from wireless cameras that happen to get sent to the ingestion bucket will be routed instead to the `animl-images-parkinglot-prod` bucket so that Animl isn't trying to process new images while the updates are being deployed.

4. Wait for messages in ALL SQS queues to wind down to zero (i.e., if there's currently a bulk upload job being processed, wait for it to finish).

5. Backup prod DB by running `npm run export-db-prod` from the `animl-api` project root.

6. Deploy animl-api to prod.

7. Turn off `IN_MAINTENANCE_MODE` in animl-frontend and animl-ingest, and deploy both to prod, and clear cloudfront cache.

8. Copy any images that happened to land in `animl-images-parkinglot-prod` while the stacks were being deployed to `animl-images-ingestion-prod`, and then delete them from the parking lot bucket.

## Recovering deleted images

`animl-images-serving-prod` has versioning enabled with a **90 day** recovery window. A delete does not remove the object; it hides it behind a _delete marker_, and the previous version stays retrievable until the `expire-noncurrent-versions` lifecycle rule reaps it. Restoring is therefore just a matter of removing the delete marker.

> **This restores image files only.** Deleting images also removes their `Image` documents from MongoDB — labels, bounding boxes, validations and comments live there, not in S3. A full recovery needs both an S3 restore _and_ a MongoDB restore (`npm run export-db-prod` snapshots, or Atlas point-in-time restore). Do the MongoDB side first, since the `_id` values are what the S3 keys are derived from.

Each image is three objects, so a restore touches all three prefixes:

```
original/<imageId>-original.jpg
medium/<imageId>-medium.jpg
small/<imageId>-small.jpg
```

**1. Confirm the objects are recoverable.** If `DeleteMarkers` comes back empty, the deletion is older than 90 days and the versions are gone.

```bash
aws-vault exec animl -- aws s3api list-object-versions \
  --bucket animl-images-serving-prod \
  --prefix original/<imageId> \
  --query '{markers: DeleteMarkers[?IsLatest].VersionId, versions: Versions[].VersionId}'
```

**2. Restore a single object** by deleting its delete marker:

```bash
aws-vault exec animl -- aws s3api delete-object \
  --bucket animl-images-serving-prod \
  --key original/<imageId>-original.jpg \
  --version-id <deleteMarkerVersionId>
```

**3. Restore in bulk** — for a whole prefix, remove every current delete marker under it:

```bash
BUCKET=animl-images-serving-prod
PREFIX=original/

aws-vault exec animl -- aws s3api list-object-versions \
  --bucket "$BUCKET" --prefix "$PREFIX" \
  --query 'DeleteMarkers[?IsLatest].{Key:Key,VersionId:VersionId}' \
  --output json > /tmp/markers.json

# Review /tmp/markers.json before running the next step.
jq -r '.[] | [.Key, .VersionId] | @tsv' /tmp/markers.json | \
  while IFS=$'\t' read -r key vid; do
    aws-vault exec animl -- aws s3api delete-object \
      --bucket "$BUCKET" --key "$key" --version-id "$vid"
  done
```

Because CloudFront caches aggressively (`MinTTL` 86400), invalidate the affected paths after a restore or the images will still 404 for users.

## Related repos

Animl is comprised of a number of microservices, most of which are managed in their own repositories.

### Core services

Services necessary to run Animl:

- [Animl Ingest](http://github.com/tnc-ca-geo/animl-ingest)
- [Animl API](http://github.com/tnc-ca-geo/animl-api)
- [Animl Frontend](http://github.com/tnc-ca-geo/animl-frontend)
- [EXIF API](https://github.com/tnc-ca-geo/exif-api)

### Wireless camera services

Services related to ingesting and processing wireless camera trap data:

- [Animl Base](http://github.com/tnc-ca-geo/animl-base)
- [Animl Email Relay](https://github.com/tnc-ca-geo/animl-email-relay)
- [Animl Ingest API](https://github.com/tnc-ca-geo/animl-ingest-api)

### Misc. services

- [Animl ML](http://github.com/tnc-ca-geo/animl-ml)
- [Animl Analytics](http://github.com/tnc-ca-geo/animl-analytics)
