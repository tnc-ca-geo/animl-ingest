import CloudFormation from '@aws-sdk/client-cloudformation';

export async function handler(event) {
    const cf = new CloudFormation.CloudFormationClient({ region: process.env.AWS_DEFAULT_REGION || 'us-east-1' });

    const alarm = JSON.parse(event.Records[0].Sns.Message).AlarmName;

    await cf.send(new CloudFormation.DeleteStackCommand({
        StackName: alarm.replace('-sqs-empty', '')
    }));

    console.log('ok - stack deletion complete');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await handler();
}
