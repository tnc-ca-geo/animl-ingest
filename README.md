# Animl Ingest
Lambda function for ingesting and processing camera trap images.

## Related repos

- Animl API               http://github.com/tnc-ca-geo/animl-api
- Animl frontend          http://github.com/tnc-ca-geo/animl-frontend
- Animl base program      http://github.com/tnc-ca-geo/animl-base
- Animl ingest function   http://github.com/tnc-ca-geo/animl-ingest
- Exif service            https://github.com/tnc-ca-geo/exif-api
- Animl email extraction  https://github.com/tnc-ca-geo/animl-email-relay
- Animl ML resources      http://github.com/tnc-ca-geo/animl-ml
- Animl analytics         http://github.com/tnc-ca-geo/animl-analytics

## About

The animl-ingest stack is a collection of AWS resources managed by the
[Serverless framework](https://www.serverless.com/). When users or applications
such as [animl-base](http://github.com/tnc-ca-geo/animl-base) upload images to
the ```animl-staging-<stage>``` bucket, a lambda function:
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
```serverles.yml``` will be looking for. Good instructions
[here](https://www.serverless.com/framework/docs/providers/aws/guide/credentials/).

### Make a project direcory and clone this repo

```sh
git clone https://github.com/tnc-ca-geo/animl-ingest.git
cd animl-ingest
npm install
```

## Dev deployment
From project root folder (where ```serverless.yml``` lives), run the following to deploy or update the stack:

```
# Deploy or update a development stack:
serverless deploy --stage dev

# Deploy or update a production stack:
serverless deploy --stage prod
```

## Prod deployment
Use caution when deploying to production, as the application involves multiple stacks (animl-ingest, animl-api, animl-frontend), and often the deployments need to be synchronized. For major deployments to prod in which there are breaking changes that affect the other components of the stack, follow these steps:

1. Set the frontend `IN_MAINTENANCE_MODE` to `true` (in `animl-frontend/src/config.js`), deploy to prod, then invalidate its cloudfront cache. This will temporarily prevent users from interacting with the frontend (editing labels, bulk uploading images, etc.) while the rest of the updates are being deployed.

2. Set ingest-image's `IN_MAINTENANCE_MODE` to `true` (in `animl-ingest/ingest-image/task.js`) and deploy to prod. While in maintenance mode, any images from wireless cameras that happen to get sent to the ingestion bucket will be routed instead to the `animl-images-parkinglot-prod` bucket so that Animl isn't trying to process new images while the updates are being deployed.
   
3. Wait for messages in ALL SQS queues to wind down to zero (i.e., if there's currently a bulk upload job being processed, wait for it to finish).

4. Backup prod DB by running `npm run export-db-prod` from the `animl-api` project root.

5. Deploy animl-api to prod.

6. Turn off `IN_MAINTENANCE_MODE` in animl-frontend and animl-ingest, and deploy both to prod, and clear cloudfront cache.

7. Copy any images that happened to land in `animl-images-parkinglot-prod` while the stacks were being deployed to `animl-images-ingestion-prod`, and then delete them from the parking lot bucket.
