"""Deployment regressions: bootstrap activation, readiness, and rollback detection."""
import sys
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from activate import activate_service


class ActivationTests(unittest.TestCase):
    """Verify that CircleCI cannot succeed with zero tasks or a rolled-back image."""

    def setUp(self):
        """Build an isolated ECS client with one healthy requested task per test."""
        self.service = {'status': 'ACTIVE', 'taskDefinition': 'requested',
                        'desiredCount': 1, 'runningCount': 1, 'pendingCount': 0,
                        'deployments': [{'rolloutState': 'COMPLETED'}]}
        self.ecs = Mock()
        self.ecs.describe_services.return_value = {'services': [self.service]}
        self.ecs.describe_task_definition.return_value = {'taskDefinition': {
            'containerDefinitions': [{'name': 'forms-api-v6', 'image': 'repo:42'}]}}
        self.ecs.list_tasks.return_value = {'taskArns': ['task']}
        self.ecs.describe_tasks.return_value = {'tasks': [{
            'taskDefinitionArn': 'requested', 'lastStatus': 'RUNNING', 'healthStatus': 'HEALTHY'}]}
        self.poll = patch('activate.wait_until', side_effect=lambda label, check: check())
        self.poll.start()
        self.addCleanup(self.poll.stop)

    def run_activation(self):
        """Invoke activation against the fake ECS client and expected release image."""
        return activate_service(self.ecs, 'cluster', 'service', 'repo:42')

    def test_bootstrap_starts_one_replica(self):
        """A successfully promoted zero-count service starts without another manual step."""
        bootstrap = dict(self.service, desiredCount=0, runningCount=0)
        self.ecs.describe_services.side_effect = [
            {'services': [bootstrap]}, {'services': [self.service]}]
        self.assertEqual(self.run_activation(), self.service)
        self.ecs.update_service.assert_called_once_with(
            cluster='cluster', service='service', desiredCount=1)

    def test_existing_capacity_is_preserved(self):
        """Normal releases retain the operator's nonzero replica count."""
        self.service.update(desiredCount=2, runningCount=2)
        task = self.ecs.describe_tasks.return_value['tasks'][0]
        self.ecs.describe_tasks.return_value['tasks'].append(deepcopy(task))
        self.assertEqual(self.run_activation(), self.service)
        self.ecs.update_service.assert_not_called()

    def test_wrong_image_never_starts(self):
        """A stale shared-script success must not activate the bootstrap image."""
        self.ecs.describe_task_definition.return_value['taskDefinition'][
            'containerDefinitions'][0]['image'] = 'repo:old'
        with self.assertRaisesRegex(RuntimeError, 'requested runtime image'):
            self.run_activation()
        self.ecs.update_service.assert_not_called()

    def test_rollback_is_failure(self):
        """A healthy previous release is still a failure for this CircleCI deployment."""
        self.ecs.describe_services.side_effect = [
            {'services': [self.service]},
            {'services': [dict(self.service, taskDefinition='previous')]}]
        with self.assertRaisesRegex(RuntimeError, 'rolled back'):
            self.run_activation()

    def test_running_but_unhealthy_is_not_success(self):
        """Running counts alone do not prove that readiness checks passed."""
        self.ecs.describe_tasks.return_value['tasks'][0]['healthStatus'] = 'UNKNOWN'
        self.assertIsNone(self.run_activation())

    def test_failed_rollout_is_failure(self):
        """An ECS circuit breaker failure must fail the release observation."""
        self.service['deployments'][0]['rolloutState'] = 'FAILED'
        with self.assertRaisesRegex(RuntimeError, 'deployment failed'):
            self.run_activation()


if __name__ == '__main__':
    unittest.main()
