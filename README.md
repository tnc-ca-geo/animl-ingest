# Animl Ingest

Lambda function for ingesting and processing camera trap images.

## Related repos

- Animl API http://github.com/tnc-ca-geo/animl-api
- Animl frontend http://github.com/tnc-ca-geo/animl-frontend
- Animl base program http://github.com/tnc-ca-geo/animl-base
- Animl ingest function http://github.com/tnc-ca-geo/animl-ingest
- Exif service https://github.com/tnc-ca-geo/exif-api
- Animl email extraction https://github.com/tnc-ca-geo/animl-email-relay
- Animl ML resources http://github.com/tnc-ca-geo/animl-ml
- Animl analytics http://github.com/tnc-ca-geo/animl-analytics

## About

The animl-ingest stack is a collection of AWS resources managed by the
[Serverless framework](https://www.serverless.com/). When users or applications
such as [animl-base](http://github.com/tnc-ca-geo/animl-base) upload images to
the `animl-staging-<stage>` bucket, a lambda function:

- extracts EXIF metadata
- creats a thumbnail of the image
- stores the thumbnail and the original in buckets for production
  access
- passes along the metadata in a POST request to a graphQL server to create a
  record of the image metadata in a database
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

# Deploy or update a production stack:
serverless deploy --stage prod
```

## Prod deployment

Use caution when deploying to production, as the application involves multiple stacks (animl-ingest, animl-api, animl-frontend), and often the deployments need to be synchronized. For major deployments to prod in which there are breaking changes that affect the other components of the stack, follow these steps:

1. Set the frontend `IN_MAINTENANCE_MODE` to `true` (in `animl-frontend/src/config.js`), deploy to prod, then invalidate its cloudfront cache. This will temporarily prevent users from interacting with the frontend (editing labels, bulk uploading images, etc.) while the rest of the updates are being deployed.

2. Manually check batch logs and the DB to make sure there aren't any fresh uploads that are in progress but haven't yet been fully unzipped. In the DB, those batches would have a `created`: <date_time> property but wouldn't yet have `uploadComplete` or `processingStart` or `ingestionComplete` fields. See this issue more info: https://github.com/tnc-ca-geo/animl-api/issues/186

3. Set ingest-image's `IN_MAINTENANCE_MODE` to `true` (in `animl-ingest/ingest-image/task.js`) and deploy to prod. While in maintenance mode, any images from wireless cameras that happen to get sent to the ingestion bucket will be routed instead to the `animl-images-parkinglot-prod` bucket so that Animl isn't trying to process new images while the updates are being deployed.

4. Wait for messages in ALL SQS queues to wind down to zero (i.e., if there's currently a bulk upload job being processed, wait for it to finish).

5. Backup prod DB by running `npm run export-db-prod` from the `animl-api` project root.

6. Deploy animl-api to prod.

7. Turn off `IN_MAINTENANCE_MODE` in animl-frontend and animl-ingest, and deploy both to prod, and clear cloudfront cache.

8. Copy any images that happened to land in `animl-images-parkinglot-prod` while the stacks were being deployed to `animl-images-ingestion-prod`, and then delete them from the parking lot bucket.

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
