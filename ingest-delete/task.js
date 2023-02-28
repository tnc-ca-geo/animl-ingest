import CloudFormation from '@aws-sdk/client-cloudformation';

export async function handler(event) {
    const cf = new CloudFormation.CloudFormationClient({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' });

    console.error(JSON.stringify(event.Records[0].Sns));
    const batch = event.batch;

    await cf.send(new CloudFormation.DeleteStackCommand({
        StackName: `${process.env.StackName}-${batch}`
    }));

    console.log('ok - stack deletion complete');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await handler();
}