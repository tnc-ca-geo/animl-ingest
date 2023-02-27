import cf from '@openaddresses/cloudfriend';

export default {
    AWSTemplateFormatVersion : '2010-09-09',
    Parameters: {
        BatchID: {
            Type: 'String',
            Description: 'The unique ID of the Batch Task'
        }
    },
    Resources: {
        PredQueue: {
            Type: 'AWS::SQS::Queue',
            Properties: {
                QueueName: cf.stackName,
                VisibilityTimeout: 1200,
                RedrivePolicy: {
                    deadLetterTargetArn: cf.getAtt('PredDLQ', 'Arn'),
                    maxReceiveCount: 3
                }
            }
        },
        PredDLQ: {
            Type: 'AWS::SQS::Queue',
            Properties: {
                QueueName: cf.join([cf.stackName, '-dlq'])
            }
        },
    }
}
