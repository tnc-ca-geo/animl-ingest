import cf from '@openaddresses/cloudfriend';

export default class Stack {
    static generate(parent, task, stage) {
        return {
            AWSTemplateFormatVersion : '2010-09-09',
            Parameters: {
                BatchID: {
                    Type: 'String',
                    Description: 'The unique ID of the Batch Task'
                },
                S3URL: {
                    Type: 'String',
                    Description: 'The S3 URL of the object that triggered the Batch Task',
                    Default: `s3://${task.bucket}/${task.key}`
                }
            },
            Resources: {
                PredQueue: {
                    Type: 'AWS::SQS::Queue',
                    Properties: {
                        QueueName: cf.stackName,
                        VisibilityTimeout: 720,
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
                PredInference: {
                    Type: 'AWS::Lambda::EventSourceMapping',
                    Properties: {
                        BatchSize: 10,
                        Enabled: true,
                        EventSourceArn: cf.getAtt('PredQueue', 'Arn'),
                        FunctionName: `animl-api-${stage}-inference`,
                        FunctionResponseTypes: ['ReportBatchItemFailures']
                    }
                },
                PredSQSAlarm: {
                    Type: 'AWS::CloudWatch::Alarm',
                    DependsOn: [
                        'PredQueue',
                        'PredDLQ'
                    ],
                    Properties: {
                        AlarmName: cf.join([cf.stackName, '-sqs-empty']),
                        AlarmDescription: 'Set an alarm to breach when SQS list is at 0',
                        ActionsEnabled: true,
                        OKActions: [],
                        AlarmActions: [
                            cf.join(['arn:', cf.partition, ':sns:', cf.region, ':', cf.accountId, `:${parent}-delete`])
                        ],
                        InsufficientDataActions: [],
                        Dimensions: [],
                        EvaluationPeriods: 10,
                        DatapointsToAlarm: 10,
                        Threshold: 0,
                        ComparisonOperator: 'LessThanOrEqualToThreshold',
                        TreatMissingData: 'missing',
                        Metrics: [{
                            Id: 'total',
                            Label: 'TotalSQS',
                            ReturnData: true,
                            Expression: 'SUM(METRICS())'
                        },{
                            Id: 'm1',
                            ReturnData: false,
                            MetricStat: {
                                Metric: {
                                    Namespace: 'AWS/SQS',
                                    MetricName: 'ApproximateNumberOfMessagesNotVisible',
                                    Dimensions: [{
                                        Name: 'QueueName',
                                        Value: cf.getAtt('PredQueue', 'QueueName')
                                    }]
                                },
                                Period: 60,
                                Stat: 'Maximum'
                            }
                        },{
                            Id: 'm2',
                            ReturnData: false,
                            MetricStat: {
                                Metric: {
                                    Namespace: 'AWS/SQS',
                                    MetricName: 'ApproximateNumberOfMessagesVisible',
                                    Dimensions: [{
                                        Name: 'QueueName',
                                        Value: cf.getAtt('PredQueue', 'QueueName')
                                    }]
                                },
                                Period: 60,
                                Stat: 'Maximum'
                            }
                        },{
                            Id: 'm3',
                            ReturnData: false,
                            MetricStat: {
                                Metric: {
                                    Namespace: 'AWS/SQS',
                                    MetricName: 'ApproximateNumberOfMessagesDelayed',
                                    Dimensions: [{
                                        Name: 'QueueName',
                                        Value: cf.getAtt('PredQueue', 'QueueName')
                                    }]
                                },
                                Period: 60,
                                Stat: 'Maximum'
                            }
                        },{
                            Id: 'm4',
                            ReturnData: false,
                            MetricStat: {
                                Metric: {
                                    Namespace: 'AWS/SQS',
                                    MetricName: 'ApproximateNumberOfMessagesNotVisible',
                                    Dimensions: [{
                                        Name: 'QueueName',
                                        Value: cf.join([cf.stackName, '-dlq'])
                                    }]
                                },
                                Period: 60,
                                Stat: 'Maximum'
                            }
                        },{
                            Id: 'm5',
                            ReturnData: false,
                            MetricStat: {
                                Metric: {
                                    Namespace: 'AWS/SQS',
                                    MetricName: 'ApproximateNumberOfMessagesVisible',
                                    Dimensions: [{
                                        Name: 'QueueName',
                                        Value: cf.getAtt('PredDLQ', 'QueueName')
                                    }]
                                },
                                Period: 60,
                                Stat: 'Maximum'
                            }
                        },{
                            Id: 'm6',
                            ReturnData: false,
                            MetricStat: {
                                Metric: {
                                    Namespace: 'AWS/SQS',
                                    MetricName: 'ApproximateNumberOfMessagesDelayed',
                                    Dimensions: [{
                                        Name: 'QueueName',
                                        Value: cf.getAtt('PredDLQ', 'QueueName')
                                    }]
                                },
                                Period: 60,
                                Stat: 'Maximum'
                            }
                        }]
                    }
                }
            }
        };
    }
}
