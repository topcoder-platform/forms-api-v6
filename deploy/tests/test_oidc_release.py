"""Migration/activation regressions without AWS credentials or network access."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import release as r


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.m = json.loads((Path(__file__).resolve().parents[1] / 'prod.json').read_text())
        self.image = 'registry/forms-api-v6@sha256:' + 'a' * 64
        self.old = r.d.arn(self.m, 'ecs', 'task-definition/forms-api-v6:1')
        self.new = r.d.arn(self.m, 'ecs', 'task-definition/forms-api-v6:2')
        self.task = {
            'family': 'forms-api-v6', 'status': 'ACTIVE', 'networkMode': 'awsvpc',
            'requiresCompatibilities': ['FARGATE'],
            'taskRoleArn': self.m['taskRoleArn'], 'executionRoleArn': self.m['executionRoleArn'],
            'containerDefinitions': [{'name': 'forms-api-v6', 'image': 'old',
                'readonlyRootFilesystem': True, 'portMappings': [{'containerPort': 3000}],
                'healthCheck': {'command': ['CMD', 'healthcheck']},
                'secrets': [{'name': 'DATABASE_URL', 'valueFrom': '/runtime/database'},
                            {'name': 'AUTH_SECRET', 'valueFrom': '/runtime/auth'}]}],
        }
        self.previous = {
            'status': 'ACTIVE', 'serviceArn': r.d.arn(self.m, 'ecs', f"service/{self.m['cluster']}/{self.m['service']}"),
            'taskDefinition': self.old, 'desiredCount': 2, 'runningCount': 2, 'pendingCount': 0,
            'deploymentConfiguration': {'deploymentCircuitBreaker': {'enable': True, 'rollback': True}},
            'deployments': [{'taskDefinition': self.old, 'rolloutState': 'COMPLETED'}],
            'networkConfiguration': {'awsvpcConfiguration': {'subnets': ['private'], 'assignPublicIp': 'DISABLED'}},
        }

    def test_migration_has_only_its_runtime_database_reference(self):
        original = deepcopy(self.task)
        request = r.migration_request(self.m, self.task, [], self.image)
        container = request['containerDefinitions'][0]
        self.assertEqual(request['family'], 'forms-api-v6-migrate')
        self.assertEqual(request['executionRoleArn'], self.m['executionRoleArn'])
        self.assertEqual(container['secrets'], [{'name': 'DATABASE_URL', 'valueFrom': '/config/forms-api-v6/appvar/MIGRATION_DATABASE_URL'}])
        self.assertNotIn('healthCheck', container)
        self.assertEqual(container['command'], ['node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'])
        self.assertNotIn('tags', request)
        self.assertEqual(self.task, original)

    def test_wrong_role_stops_before_a_migration_can_run(self):
        self.task['executionRoleArn'] = 'unexpected'
        with self.assertRaises(r.d.DeployError):
            r.migration_request(self.m, self.task, [], self.image)

    def test_zero_capacity_is_only_an_initial_state(self):
        self.previous.update(desiredCount=0, runningCount=0)
        self.assertTrue(r.initial_stable(self.previous, self.old))
        self.assertFalse(r.d.stable(self.previous, self.old))

    def test_incomplete_stack_bootstrap_blocks_release(self):
        aws = Mock()
        aws.call.return_value = {'Stacks': [{'StackStatus': 'UPDATE_COMPLETE', 'Parameters': [
            {'ParameterKey': 'Environment', 'ParameterValue': 'production'},
            {'ParameterKey': 'BootstrapOnly', 'ParameterValue': 'true'},
        ]}]}
        with self.assertRaisesRegex(r.d.DeployError, 'bootstrap'):
            r.stack_settings(aws, self.m)

    def migration_aws(self, exit_code=0, digest=None):
        aws = Mock()
        definition = r.d.arn(self.m, 'ecs', 'task-definition/forms-api-v6-migrate:4')
        def call(api_service, operation, **kwargs):
            if operation == 'register-task-definition':
                return {'taskDefinition': {'taskDefinitionArn': definition}}
            if operation == 'run-task':
                self.assertEqual(kwargs['networkConfiguration'], self.previous['networkConfiguration'])
                return {'tasks': [{'taskArn': 'migration-task'}]}
            if operation == 'describe-tasks':
                return {'tasks': [{'taskDefinitionArn': definition, 'lastStatus': 'STOPPED',
                    'containers': [{'exitCode': exit_code, 'imageDigest': digest or 'sha256:' + 'a' * 64}]}]}
            self.fail('Unexpected AWS operation: ' + operation)
        aws.call.side_effect = call
        return aws

    def test_failed_or_wrong_image_migration_never_promotes(self):
        for code, digest in ((1, None), (0, 'sha256:' + 'b' * 64)):
            with self.subTest(code=code, digest=digest), self.assertRaises(r.d.DeployError):
                r.migrate(self.migration_aws(code, digest), self.m, self.previous, self.task, [], self.image)

    def test_successful_migration_uses_the_private_service_network(self):
        self.assertEqual(r.migrate(self.migration_aws(), self.m, self.previous, self.task, [], self.image), 'migration-task')

    def test_migration_failure_stops_release_before_runtime_registration(self):
        aws = Mock()
        aws.call.return_value = {'taskDefinition': self.task}
        publisher = Mock()
        publisher.publish.return_value = self.image
        with patch.object(r, 'stack_settings'), patch.object(r, 'read_service', return_value=self.previous), \
             patch.object(r, 'migrate', side_effect=r.d.DeployError('migration failed')), patch.object(r, 'promote') as promote:
            with self.assertRaises(r.d.DeployError):
                r.release(aws, self.m, publisher, 'a' * 40 + '-1')
            self.assertEqual(publisher.publish.call_count, 2)
            promote.assert_not_called()

    def test_activation_preserves_positive_capacity_and_starts_zero_at_one(self):
        for desired in (0, 3):
            with self.subTest(desired=desired):
                previous = deepcopy(self.previous)
                previous.update(desiredCount=desired, runningCount=desired)
                request = r.d.task_request(self.m, self.task, [], {'forms-api-v6': self.image})
                aws = Mock()
                def call(api_service, operation, **kwargs):
                    if operation == 'register-task-definition':
                        self.assertNotIn('tags', kwargs)
                        return {'taskDefinition': {'taskDefinitionArn': self.new}}
                    if operation == 'describe-task-definition':
                        return {'taskDefinition': {k: v for k, v in request.items() if k != 'tags'}, 'tags': []}
                    if operation == 'update-service':
                        self.assertEqual(kwargs['desiredCount'], max(1, desired))
                        return {'service': {'taskDefinition': self.new}}
                    self.fail('Unexpected AWS operation: ' + operation)
                aws.call.side_effect = call
                with patch.object(r, 'read_service', return_value=previous), \
                     patch.object(r.d, 'read_service'), patch.object(r.d, 'stable', return_value=True), \
                     patch.object(r.d, 'verify_running', return_value=True):
                    self.assertEqual(r.promote(aws, self.m, previous, self.task, [], self.image), self.new)

    def test_optional_circuit_breaker_fields_preserve_safety_flags(self):
        self.previous['deploymentConfiguration']['deploymentCircuitBreaker'].update(resetOnHealthyTask=True, thresholdConfiguration={'minimumFailureThreshold': 3})
        aws = Mock()
        aws.call.return_value = {'services': [self.previous]}
        self.assertEqual(r.read_service(aws, self.m), self.previous)
        for flag in ('enable', 'rollback'):
            with self.subTest(flag=flag):
                self.previous['deploymentConfiguration']['deploymentCircuitBreaker'][flag] = False
                with self.assertRaises(r.d.DeployError):
                    r.read_service(aws, self.m)
                self.previous['deploymentConfiguration']['deploymentCircuitBreaker'][flag] = True


if __name__ == '__main__':
    unittest.main()
