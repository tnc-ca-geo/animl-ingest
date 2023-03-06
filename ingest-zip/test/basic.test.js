import test from 'tape';
import Sinon from 'sinon';
import IngestZip from '../index.js';
import S3 from '@aws-sdk/client-s3';
import CloudFormation from '@aws-sdk/client-cloudformation';
import SSM from '@aws-sdk/client-ssm';
import fs from 'node:fs';

test('Basic', async (t) => {
    const order = [];
    Sinon.stub(SSM.SSMClient.prototype, 'send').callsFake((command) => {
        if (command instanceof SSM.GetParametersCommand) {
            order.push('SSM:GetParametersCommand');

            t.deepEquals(command.input, {
                Names: ['/api/url-test'],
                WithDecryption: true
            });

            return Promise.resolve({
                Parameters: [{
                    ParamaterKey: '/api/url-test',
                    ParameterValue: 'http://example.com'
                }]
            });
        } else {
            t.fail('Unexpected Command');
        }
    });

    Sinon.stub(S3.S3Client.prototype, 'send').callsFake((command) => {
        if (command instanceof S3.GetObjectCommand) {
            order.push(`S3:GetObjectCommand:${command.input.Key}`);

            t.deepEquals(command.input, {
                Bucket: 'example-bucket',
                Key: 'example-key'
            });

            return Promise.resolve({
                Body: fs.createReadStream(new URL('./fixtures/test.zip', import.meta.url))
            });
        } else if (command instanceof S3.PutObjectCommand) {
            order.push(`S3:PutObjectCommand`);

            t.equals(command.input.Bucket, 'example-bucket');

            return Promise.resolve({});
        } else if (command instanceof S3.DeleteObjectCommand) {
            order.push(`S3:DeleteObjectCommand:${command.input.Key}`);

            t.equals(command.input.Bucket, 'example-bucket');

            return Promise.resolve({});
        } else {
            t.fail('Unexpected Command');
        }
    });

    Sinon.stub(CloudFormation.CloudFormationClient.prototype, 'send').callsFake((command) => {
        if (command instanceof CloudFormation.CreateStackCommand) {
            order.push('CloudFormation:CreateStack');

            t.ok(command.input.StackName.startsWith('test-stack-batch'));

            return Promise.resolve({});
        } else {
            t.fail('Unexpected Command');
        }
    });

    try {
        process.env.TASK = JSON.stringify({ Bucket: 'example-bucket', Key: 'example-key' });
        process.env.STAGE = 'test';
        process.env.StackName = 'test-stack';
        await IngestZip();
    } catch (err) {
        t.error(err);
    }

    t.deepEquals(order, [
        'SSM:GetParametersCommand',
        'S3:GetObjectCommand:example-key',
        'CloudFormation:CreateStack',
        'S3:PutObjectCommand',
        'S3:PutObjectCommand',
        'S3:PutObjectCommand',
        'S3:PutObjectCommand',
        'S3:PutObjectCommand',
        'S3:PutObjectCommand',
        'S3:PutObjectCommand',
        'S3:PutObjectCommand',
        'S3:DeleteObjectCommand:example-key',
    ]);

    Sinon.restore();
    t.end();
});
