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
  - stores the thumbnail and the original in buckets for archive & production
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
```
mkdir animl-ingest
cd animl-ingest
git clone https://github.com/tnc-ca-geo/animl-ingest.git
cd animl-ingest
```

### Clone serverless-python-requirements plugin
This project runs in a Python Lambda environment, which means that all Python
dependencies must be installed in the OS in which the will be ultimately
executed. To accomplish this we use a Serverless plugin called
[serverless-python-requirements](https://www.serverless.com/plugins/serverless-python-requirements)
that, on ```serverless deploy```, spins up a Docker container to mimic the AWS
Lambda Linux OS, downloads any Python requirements defined in
```requirements.txt``` within the container, and packages them up to be added
to our Lambda deployment package.

The plugin works well for installing Python packages, but we also need to
include a Perl executable ([exiftool](https://exiftool.org/)) and its
dependencies in the final deployment package, and the
serverless-python-requirements plugin doesn't support some functionalty that
we need to make that happen out of the box (see issue
[here](https://github.com/UnitedIncome/serverless-python-requirements/issues/542)).
I created a fix and [pull request](https://github.com/UnitedIncome/serverless-python-requirements/pull/544)
to support this, but until the PR is accepted we have to clone the repo into
our project manually from my github profile. So from within the project root
directory, execute the following:

```
mkdir .serverless_plugins
cd .serverless_plugins
git clone --single-branch --branch recursive-docker-extra-files https://github.com/nathanielrindlaub/serverless-python-requirements.git
cd serverless-python-requirements
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

## Adding new Python packages
Perform the following steps if you need to use new Python packages in the
Lambda function.

Note: perform these operations in the `ingest-image` directory.

### Create venv and activate it
```
virtualenv venv --python=python3
source venv/bin/activate
```

### Add dependencies
```
# Example package installs
pip install pillow
pip install requests
pip install PyExifTool
```

### Freeze dependenceies in requirements.txt
```
pip freeze > requirements.txt

# Deactivate venv when you're done
deactivate
```
