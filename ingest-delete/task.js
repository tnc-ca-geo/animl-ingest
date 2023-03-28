import CloudFormation from '@aws-sdk/client-cloudformation';
import SSM from '@aws-sdk/client-ssm';

const APIKEY = process.env.APIKEY;

export async function handler(event) {
    const cf = new CloudFormation.CloudFormationClient({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' });
    const ssm = new SSM.SSMClient({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' });

    if (!event || !event.Records.length) throw new Error('Event not populated');

    const STAGE = process.env.STAGE || 'dev';

    let StackName = null;
    if (event.Records[0].Sns) {
        const alarm = JSON.parse(event.Records[0].Sns.Message).AlarmName;
        StackName =  alarm.replace('-sqs-empty', '');
    } else if (event.Records[0]) {
        console.error(event.Records[0], typeof event.Records[0]);
    } else {
        throw new Error('Unknown Event Type');
    }

    if (!StackName) throw new Error('StackName could not be determined');

    const params = new Map();
    for (const param of (await ssm.send(new SSM.GetParametersCommand({
        Names: [`/api/url-${STAGE}`],
        WithDecryption: true
    }))).Parameters) {
        console.log(`ok - setting ${param.Name}`);
        params.set(param.Name, param.Value);
    }

    console.log(`ok - deleting: ${StackName}`);

    await cf.send(new CloudFormation.DeleteStackCommand({ StackName }));

    const batchId = `batch-${StackName.replace(/^.*-batch-/, '')}`;

    console.log(`ok - batch: ${batchId}`);

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
                _id: batchId,
                processingEnd: new Date()
            }
        }
    });

    console.log('ok - stack deletion complete');
}

async function fetcher(url, body) {
    console.log('Posting metadata to API');
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': APIKEY
        },
        body: JSON.stringify(body)
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
    await handler();
}
