"""Regression tests for the v6 SSM-to-ECS appvar mapping and template preservation."""
import copy
from pathlib import Path
import unittest
from unittest.mock import Mock

from appvars import appvar_secrets, configure_template, load_template

PREFIX = '/config/forms-api-v6/appvar'
GLOBAL = '/config/common/global-appvar'


def ssm_fixture(pages):
    """Return an SSM mock serving path-indexed pages; unknown paths raise KeyError."""
    client = Mock()
    client.get_paginator.return_value.paginate.side_effect = lambda **kwargs: iter(pages[kwargs['Path']])
    return client


def parameter(path, name):
    """Return one SSM fixture with a sentinel value that must never reach a template."""
    return {'Name': path + '/' + name, 'Value': 'DO_NOT_EMBED_PARAMETER_VALUES'}


class AppvarTests(unittest.TestCase):
    """Exercise pagination, v6 precedence, safe references, and CloudFormation changes."""

    def test_service_precedence_and_all_pages(self):
        """Map every page, preferring literal env then service values over globals."""
        client = ssm_fixture({
            PREFIX: [{'Parameters': [parameter(PREFIX, 'AUTH0_CLIENT_ID'), parameter(PREFIX, 'PORT')]},
                     {'Parameters': [parameter(PREFIX, 'AUTH0_CLIENT_SECRET')]}],
            GLOBAL: [{'Parameters': [parameter(GLOBAL, 'AUTH0_CLIENT_ID'), parameter(GLOBAL, 'AUTH0_URL')]},
                     {'Parameters': [parameter(GLOBAL, 'AUTH_SECRET')]}],
        })
        result = appvar_secrets(client, PREFIX, 'aws', 'us-east-1', '123', ['PORT'])
        refs = {entry['name']: entry['valueFrom'] for entry in result}
        self.assertEqual(set(refs), {'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'AUTH0_URL', 'AUTH_SECRET'})
        self.assertEqual(refs['AUTH0_CLIENT_ID'], 'arn:aws:ssm:us-east-1:123:parameter' + PREFIX + '/AUTH0_CLIENT_ID')
        self.assertEqual(refs['AUTH0_URL'], 'arn:aws:ssm:us-east-1:123:parameter' + GLOBAL + '/AUTH0_URL')
        self.assertNotIn('DO_NOT_EMBED_PARAMETER_VALUES', str(result))
        for call in client.get_paginator.return_value.paginate.call_args_list:
            self.assertFalse(call.kwargs['Recursive'])
            self.assertFalse(call.kwargs['WithDecryption'])

    def test_template_preserves_runtime_and_other_resources(self):
        """Refresh only runtime secret bindings and a narrowly scoped IAM policy."""
        original = load_template(Path(__file__).with_name('service.yaml').read_text())
        snapshot = copy.deepcopy(original)
        client = ssm_fixture({PREFIX: [{'Parameters': [parameter(PREFIX, 'DATABASE_URL'), parameter(PREFIX, 'BUSAPI_URL')]}],
                              GLOBAL: [{'Parameters': [parameter(GLOBAL, 'AUTH_SECRET')]}]})
        result = configure_template(original, client, PREFIX, 'aws', 'us-east-1', '123')
        self.assertEqual(original, snapshot)
        self.assertEqual(result['Parameters'], original['Parameters'])
        for name in original['Resources']:
            if name not in {'TaskDefinition', 'ExecutionRole'}:
                self.assertEqual(result['Resources'][name], original['Resources'][name])
        container = result['Resources']['TaskDefinition']['Properties']['ContainerDefinitions'][0]
        before = original['Resources']['TaskDefinition']['Properties']['ContainerDefinitions'][0]
        self.assertEqual({k: v for k, v in container.items() if k != 'Secrets'},
                         {k: v for k, v in before.items() if k != 'Secrets'})
        self.assertEqual({item['Name'] for item in container['Secrets']}, {'DATABASE_URL', 'BUSAPI_URL', 'AUTH_SECRET'})
        policy = result['Resources']['ExecutionRole']['Properties']['Policies'][-1]
        self.assertEqual(policy['PolicyDocument']['Statement'][0]['Action'], ['ssm:GetParameters'])
        self.assertEqual(policy['PolicyDocument']['Statement'][0]['Resource'], [
            'arn:aws:ssm:us-east-1:123:parameter' + PREFIX + '/*',
            'arn:aws:ssm:us-east-1:123:parameter' + GLOBAL + '/*'])
        self.assertNotIn('DO_NOT_EMBED_PARAMETER_VALUES', str(result))

    def test_refresh_is_idempotent_and_removes_deleted_parameters(self):
        """Remove obsolete references without accumulating permissions on later releases."""
        original = Path(__file__).with_name('service.yaml').read_text()
        client = ssm_fixture({PREFIX: [{'Parameters': [parameter(PREFIX, 'DATABASE_URL')]}], GLOBAL: [{'Parameters': []}]})
        once = configure_template(original, client, PREFIX, 'aws', 'us-east-1', '123')
        twice = configure_template(once, client, PREFIX, 'aws', 'us-east-1', '123')
        self.assertEqual(once, twice)
        names = [entry['Name'] for entry in twice['Resources']['TaskDefinition']['Properties']['ContainerDefinitions'][0]['Secrets']]
        self.assertEqual(names, ['DATABASE_URL'])

    def test_read_errors_and_unsafe_names_stop_generation(self):
        """Fail before deployment when appvar discovery fails or returns unsafe names."""
        client = Mock()
        client.get_paginator.side_effect = RuntimeError('SSM unavailable')
        with self.assertRaises(RuntimeError):
            appvar_secrets(client, PREFIX, 'aws', 'us-east-1', '123')
        client = ssm_fixture({PREFIX: [{'Parameters': [parameter(PREFIX, 'nested/SECRET')]}]})
        with self.assertRaises(ValueError):
            appvar_secrets(client, PREFIX, 'aws', 'us-east-1', '123')

    def test_cloudformation_intrinsics_are_not_evaluated(self):
        """Preserve scalar/sequence/mapping intrinsics and reject unsafe YAML objects."""
        result = load_template('Resources:\n  Arn: !GetAtt Role.Arn\n  Choice: !If [IsDev, dev, prod]\n  Text: !Sub "${Name}"\n')
        self.assertEqual(result['Resources']['Arn'], {'Fn::GetAtt': ['Role', 'Arn']})
        self.assertEqual(result['Resources']['Choice'], {'Fn::If': ['IsDev', 'dev', 'prod']})
        with self.assertRaises(ValueError):
            load_template('Resources: !Run arbitrary')


if __name__ == '__main__':
    unittest.main()
