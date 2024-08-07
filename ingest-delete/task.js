import CloudFormation from '@aws-sdk/client-cloudformation';
import SSM from '@aws-sdk/client-ssm';
import CW from '@aws-sdk/client-cloudwatch';
import moment from 'moment';

const API_KEY = process.env.API_KEY;

export async function handler(event) {
  if (!event) throw new Error('Event not populated');

  console.log(`ok - event: ${JSON.stringify(event)}`);

  const STAGE = process.env.STAGE || 'dev';
  const params = new Map();

  let StackName = null;
  let batch = null;
  if (event.Records && event.Records[0] && event.Records[0].Sns) {
    const alarm = JSON.parse(event.Records[0].Sns.Message).AlarmName;
    StackName = alarm.replace('-sqs-empty', '');
    batch = `batch-${StackName.replace(/^.*-batch-/, '')}`;
  } else if (event.batch) {
    StackName = `animl-ingest-${STAGE}-${event.batch}`;
    batch = event.batch;
  } else if (event.source) {
    return await scheduledDelete(STAGE);
  } else {
    throw new Error('Unknown Event Type');
  }

  if (!StackName) throw new Error('StackName could not be determined');

  try {
    const cf = new CloudFormation.CloudFormationClient({
      region: process.env.AWS_DEFAULT_REGION || 'us-west-2',
    });
    const ssm = new SSM.SSMClient({ region: process.env.AWS_DEFAULT_REGION || 'us-west-2' });

    for (const param of (
      await ssm.send(
        new SSM.GetParametersCommand({
          Names: [`/api/url-${STAGE}`],
          WithDecryption: true,
        })
      )
    ).Parameters) {
      console.log(`ok - setting ${param.Name}`);
      params.set(param.Name, param.Value);
    }

    console.log(`ok - deleting: ${StackName}`);

    await cf.send(new CloudFormation.DeleteStackCommand({ StackName }));

    console.log(`ok - batch: ${batch}`);

    await fetcher(params.get(`/api/url-${STAGE}`), {
      query: `
                mutation UpdateBatch($input: UpdateBatchInput!){
                    updateBatch(input: $input) {
                        batch {
                            _id
                            processingStart
                            processingEnd
                            total
                        }
                    }
                }
            `,
      variables: {
        input: {
          _id: batch,
          processingEnd: new Date(),
        },
      },
    });

    console.log('ok - stack deletion complete');
  } catch (err) {
    console.error(err);

    if (params.has(`/api/url-${STAGE}`)) {
      await fetcher(params.get(`/api/url-${STAGE}`), {
        query: `
                    mutation CreateBatchError($input: CreateBatchErrorInput!) {
                        createBatchError(input: $input) {
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
            batch: batch,
          },
        },
      });
    } else {
      console.error('not ok - Failed to post to CreateBatchError');
    }

    throw err;
  }
}

async function scheduledDelete(stage) {
  const cf = new CloudFormation.CloudFormationClient({
    region: process.env.AWS_DEFAULT_REGION || 'us-west-2',
  });

  let stacks = [];
  let nextToken = undefined;
  do {
    const res = await cf.send(
      new CloudFormation.ListStacksCommand({
        NextToken: nextToken,
      })
    );

    stacks.push(...res.StackSummaries);
    nextToken = res.NextToken;
  } while (nextToken);

  stacks = stacks
    .filter((stack) => {
      return stack.StackName.startsWith(`animl-ingest-${stage}-batch-`);
    })
    .filter((stack) => {
      return stack.StackStatus !== 'DELETE_COMPLETE';
    })
    .filter((stack) => {
      return moment(stack.CreationTime).isSameOrBefore(moment().subtract(24, 'hours'));
    });

  const cw = new CW.CloudWatchClient({ region: process.env.AWS_DEFAULT_REGION || 'us-west-2' });
  console.log(`ok - ${stacks.length} candidate stacks for deletion`);
  for (const stack of stacks) {
    console.log(`ok - checking alarm state ${stack.StackName}`);
    const alarm = await cw.send(
      new CW.DescribeAlarmsCommand({
        AlarmNames: [`${stack.StackName}-sqs-empty`],
      })
    );

    if (alarm.MetricAlarms[0].StateValue === 'INSUFFICIENT_DATA') {
      console.log(`ok - deleting ${stack.StackName}`);
      await cf.send(new CloudFormation.DeleteStackCommand({ StackName: stack.StackName }));
    }
  }
}

async function fetcher(url, body) {
  console.log('Posting metadata to API');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify(body),
  });

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

if (import.meta.url === `file://${process.argv[1]}`) {
  await handler(process.env.EVENT ? JSON.parse(process.env.EVENT) : {});
}
