#!/usr/bin/env python3
"""Inject Forms and global SSM appvars as ECS secret references, matching tc-deploy-scripts -j.

CLI: appvars.py dev|production [--apply]. Defaults to a read-only configuration plan.
Uses inherited AWS credentials. Never decrypts parameters or writes their values.
The apply mode updates only the running stack's appvar bindings and execution-role
SSM permissions, preserving its image, parameters, networking, and migration setup.
"""
import argparse
import copy
import json
import re
import time

import boto3
import yaml

GLOBAL_APPVARS = '/config/common/global-appvar'


class CloudFormationLoader(yaml.SafeLoader):
    """Read CloudFormation YAML intrinsics as JSON objects without evaluating tags.

    Used when AWS returns an existing YAML template rather than a JSON mapping.
    Only standard intrinsic tags are accepted; unknown tags raise ValueError.
    """


def intrinsic(loader, tag, node):
    """Convert one CloudFormation YAML tag to its JSON representation.

    Takes the safe loader, tag suffix, and YAML node; returns an intrinsic mapping.
    Raises ValueError for unsupported tags and propagates malformed YAML errors.
    """
    if tag not in {'Ref', 'Condition', 'Base64', 'GetAtt', 'GetAZs', 'ImportValue',
                   'Join', 'Select', 'Split', 'Sub', 'FindInMap', 'If', 'Equals',
                   'And', 'Or', 'Not', 'Cidr', 'Transform', 'Length', 'ToJsonString'}:
        raise ValueError('Unsupported CloudFormation intrinsic: ' + tag)
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node)
    else:
        value = loader.construct_mapping(node)
    if tag == 'GetAtt' and isinstance(value, str):
        value = value.split('.', 1)
    return {tag if tag in {'Ref', 'Condition'} else 'Fn::' + tag: value}


CloudFormationLoader.add_multi_constructor('!', intrinsic)


def load_template(body):
    """Return an independent JSON-compatible stack template from an AWS template body.

    Accepts the dict or YAML/JSON text returned by get_template. Raises ValueError
    for missing resources, and propagates safe YAML parsing errors.
    """
    template = copy.deepcopy(body) if isinstance(body, dict) else yaml.load(body, Loader=CloudFormationLoader)
    if not isinstance(template, dict) or not isinstance(template.get('Resources'), dict):
        raise ValueError('CloudFormation template has no resources.')
    return template


def appvar_secrets(ssm, prefix, partition, region, account, environment_names=()):
    """Discover all direct SSM appvars with the same precedence as master_deploy.sh -j.

    Takes the SSM client, service path, AWS ARN components, and existing literal
    environment names. Returns ECS name/valueFrom entries: literal environment
    first, service parameters next, global parameters last. Pagination is consumed
    without decryption. Raises ValueError for unsafe variable names; AWS errors
    propagate. Values are never placed in the generated task definition.
    """
    seen = set(environment_names)
    secrets = []
    for path in [prefix.rstrip('/'), GLOBAL_APPVARS]:
        for page in ssm.get_paginator('get_parameters_by_path').paginate(
                Path=path, Recursive=False, WithDecryption=False):
            for parameter in page['Parameters']:
                name = parameter['Name'].removeprefix(path + '/')
                if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
                    raise ValueError('Appvar name is not a direct environment variable: ' + parameter['Name'])
                if name not in seen:
                    seen.add(name)
                    secrets.append({'name': name, 'valueFrom':
                                    f'arn:{partition}:ssm:{region}:{account}:parameter{parameter["Name"]}'})
    return sorted(secrets, key=lambda item: item['name'])


def configure_template(body, ssm, prefix, partition, region, account):
    """Refresh the Forms runtime secrets and execution-role grants in a stack template.

    Takes the current template, SSM client, and deployment identifiers. Returns a
    new template, preserving unrelated resources, runtime image, and literal env.
    Rebuilds the secret list so removed parameters are no longer injected. Raises
    KeyError for an unexpected Forms stack layout, ValueError for invalid appvars,
    and propagates SSM read failures. Used by releases and configuration-only rolls.
    """
    template = load_template(body)
    resources = template['Resources']
    containers = resources['TaskDefinition']['Properties']['ContainerDefinitions']
    container = next(item for item in containers if item['Name'] == 'forms-api-v6')
    entries = appvar_secrets(ssm, prefix, partition, region, account,
                            [item['Name'] for item in container.get('Environment', [])])
    container['Secrets'] = [{'Name': item['name'], 'ValueFrom': item['valueFrom']} for item in entries]
    policies = resources['ExecutionRole']['Properties']['Policies']
    policy_name = 'forms-runtime-appvars'
    policies[:] = [policy for policy in policies if policy['PolicyName'] != policy_name]
    policies.append({'PolicyName': policy_name, 'PolicyDocument': {
        'Version': '2012-10-17', 'Statement': [{
            'Effect': 'Allow', 'Action': ['ssm:GetParameters'],
            'Resource': [f'arn:{partition}:ssm:{region}:{account}:parameter{path.rstrip("/")}/*'
                         for path in [prefix, GLOBAL_APPVARS]],
        }],
    }})
    return template


def main():
    """Plan or apply appvar injection to the selected existing Forms stack.

    Reads CLI arguments and inherited AWS credentials; returns None after showing
    names only or completing a configuration roll. Raises on account mismatch,
    unstable stack, invalid template, AWS errors, deployment rollback, or timeout.
    Does not submit forms, replay events, run migrations, or change appvar values.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('environment', choices=['dev', 'production'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    session = boto3.Session(region_name='us-east-1')
    identity = session.client('sts').get_caller_identity()
    account = identity['Account']
    if (account == '811668436784') != (args.environment == 'dev'):
        raise RuntimeError('AWS account does not match the selected environment.')
    cfn = session.client('cloudformation')
    stack_name = 'forms-api-v6-' + args.environment
    stack = cfn.describe_stacks(StackName=stack_name)['Stacks'][0]
    if stack['StackStatus'] not in {'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'}:
        raise RuntimeError('Stack is not stable; inspect the existing operation.')
    settings = {item['ParameterKey']: item['ParameterValue'] for item in stack['Parameters']}
    if settings['Environment'] != args.environment or settings['BootstrapOnly'] != 'false':
        raise RuntimeError('Stack environment or bootstrap state does not permit a configuration roll.')
    original = cfn.get_template(StackName=stack_name, TemplateStage='Original')['TemplateBody']
    template = configure_template(original, session.client('ssm'), settings['ParameterPrefix'],
                                  identity['Arn'].split(':')[1], session.region_name, account)
    container = template['Resources']['TaskDefinition']['Properties']['ContainerDefinitions'][0]
    print('Runtime SSM appvars: ' + ', '.join(item['Name'] for item in container['Secrets']))
    body = json.dumps(template)
    cfn.validate_template(TemplateBody=body)
    if not args.apply:
        print('Template validated. Re-run with --apply to roll the existing service image with these bindings.')
        return
    if template == load_template(original):
        print('Appvar bindings and execution permissions already match; no stack change required.')
        return
    cfn.update_stack(StackName=stack_name, TemplateBody=body,
                     Parameters=[{'ParameterKey': item['ParameterKey'], 'UsePreviousValue': True}
                                 for item in stack['Parameters']], Capabilities=['CAPABILITY_IAM'])
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        state = cfn.describe_stacks(StackName=stack_name)['Stacks'][0]['StackStatus']
        if state == 'UPDATE_COMPLETE':
            print('Appvar configuration deployed: ' + stack_name)
            return
        if state not in {'UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS'}:
            raise RuntimeError('Configuration roll failed or rolled back: ' + state)
        print('Waiting for appvar configuration roll...', flush=True)
        time.sleep(15)
    raise RuntimeError('Timed out observing the stack; inspect its existing operation before retrying.')


if __name__ == '__main__':
    main()
