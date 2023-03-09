import test from 'tape';
import Sinon from 'sinon';
import IngestDelete from '../task.js';
import CloudFormation from '@aws-sdk/client-cloudformation';
import { MockAgent, setGlobalDispatcher } from 'undici';
import SSM from '@aws-sdk/client-ssm';

test('Basic', async (t) => {
    const mockAgent = new MockAgent();
    setGlobalDispatcher(mockAgent);

    const mockPool = mockAgent.get('http://example.com');

    mockPool.intercept({
        path: '/',
        method: 'POST'
    }).reply(200, { message: 'posted' });

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
                    Name: '/api/url-test',
                    Value: 'http://example.com'
                }]
            });
        } else {
            t.fail('Unexpected Command');
        }
    });

    Sinon.stub(CloudFormation.CloudFormationClient.prototype, 'send').callsFake((command) => {
        if (command instanceof CloudFormation.DeleteStackCommand) {
            order.push('CloudFormation:DeleteStack');

            t.ok(command.input.StackName.startsWith('test-stack-batch'));

            return Promise.resolve({});
        } else {
            t.fail('Unexpected Command');
        }
    });

    try {
        process.env.STAGE = 'test';
        await IngestDelete({
            Records: [{
                Sns: {
                    Message: JSON.stringify({
                        AlarmName: 'test-stack-batch-847400c8-8e54-4a40-ab5c-0d593939c883-sqs-empty'
                    })
                }
            }]
        });
    } catch (err) {
        t.error(err);
    }

    t.deepEquals(order, [
        'SSM:GetParametersCommand',
        'CloudFormation:DeleteStack'
    ]);

    Sinon.restore();
    t.end();
});
