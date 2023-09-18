# Animl Ingest
Lambda function for ingesting and processing camera trap images.

## Related repos

- Animl API               http://github.com/tnc-ca-geo/animl-api
- Animl frontend          http://github.com/tnc-ca-geo/animl-frontend
- Animl base program      http://github.com/tnc-ca-geo/animl-base
- Animl ingest function   http://github.com/tnc-ca-geo/animl-ingest
- Animl ML resources      http://github.com/tnc-ca-geo/animl-ml
- Animl desktop app       https://github.com/tnc-ca-geo/animl-desktop

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

## Deployment
From project root folder (where ```serverless.yml``` lives), run the following to deploy or update the stack:

```
# Deploy or update a development stack:
serverless deploy --stage dev

# Deploy or update a production stack:
serverless deploy --stage prod
```

