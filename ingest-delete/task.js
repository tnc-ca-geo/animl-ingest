import CloudFormation from '@aws-sdk/client-cloudformation';

export default async function handler(payload) {
    const cf = new CloudFormation.CloudFormationClient({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' });

    console.error(payload);
    const batch = payload.batch;

    await cf.send(new CloudFormation.DeleteStackCommand({
        StackName: `${process.env.StackName}-${batch}`
    }));

    console.log('ok - stack deletion complete');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await handler();
}
