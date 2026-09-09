#!/usr/bin/env python3
"""Deploy prebuilt runtime and migration images using the existing Forms stack.

CLI: release.py dev|production IMAGE_TAG [RUNTIME_IMAGE] [MIGRATION_IMAGE].
Requires inherited AWS credentials, boto3, and Docker. Pushes immutable ECR tags,
executes migrations as a private one-shot ECS task, then updates CloudFormation.
Raises on failures; runtime promotion never occurs after failed migrations.
"""
import base64
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

import boto3


def wait_until(description, check, seconds=1800):
    """Poll a live deployment check every 15 seconds, returning its truthy result.

    Inputs are a progress label, callable, and timeout. Check exceptions propagate;
    timeout raises RuntimeError without restarting the observed deployment.
    """
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        print(f'Waiting for {description}...', flush=True)
        time.sleep(15)
    raise RuntimeError(f'Timed out observing {description}; inspect the existing AWS operation before retrying.')


def main():
    """Validate release arguments and environment, migrate, promote, and save evidence.

    Returns None on success; AWS, Docker, failed migration, and failed deployment
    errors propagate. Credentials are passed through stdin/environment, never argv.
    """
    if len(sys.argv) not in (3, 5) or sys.argv[1] not in ('dev', 'production'):
        raise RuntimeError(__doc__)
    environment, tag = sys.argv[1:3]
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,110}', tag):
        raise RuntimeError('Invalid immutable release tag.')
    local_runtime, local_migration = sys.argv[3:] or ['forms-api-v6:candidate', 'forms-api-v6:migrate-candidate']
    session = boto3.Session(region_name=os.environ.get('AWS_REGION', 'us-east-1'))
    account = session.client('sts').get_caller_identity()['Account']
    if (account == '811668436784') != (environment == 'dev'):
        raise RuntimeError('AWS account does not match the selected deployment environment.')
    cfn, ecs, ecr = [session.client(name) for name in ['cloudformation', 'ecs', 'ecr']]
    stack_name = f'forms-api-v6-{environment}'
    stack = cfn.describe_stacks(StackName=stack_name)['Stacks'][0]
    if stack['StackStatus'] not in ('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'):
        raise RuntimeError('Existing stack is not stable; inspect it before releasing.')
    settings = {x['ParameterKey']: x['ParameterValue'] for x in stack['Parameters']}
    if settings['Environment'] != environment or settings['BootstrapOnly'] != 'false':
        raise RuntimeError('Stack environment or bootstrap state does not permit deployment.')
    output = {x['OutputKey']: x['OutputValue'] for x in stack['Outputs']}
    repository = output['RepositoryUri']
    authorization = ecr.get_authorization_token()['authorizationData'][0]
    user, password = base64.b64decode(authorization['authorizationToken']).decode().split(':', 1)
    subprocess.run(['docker', 'login', '--username', user, '--password-stdin', authorization['proxyEndpoint']],
                   input=password, text=True, check=True, stdout=subprocess.DEVNULL)
    images = []
    for local, suffix in [(local_runtime, ''), (local_migration, '-migrate')]:
        destination = f'{repository}:{tag}{suffix}'
        subprocess.run(['docker', 'tag', local, destination], check=True)
        subprocess.run(['docker', 'push', destination], check=True)
        digest = ecr.describe_images(repositoryName='forms-api-v6', imageIds=[{'imageTag': tag + suffix}])['imageDetails'][0]['imageDigest']
        images.append(f'{repository}@{digest}')
    current = ecs.describe_task_definition(taskDefinition=output['TaskDefinitionArn'])['taskDefinition']
    allowed = {'family', 'taskRoleArn', 'executionRoleArn', 'networkMode', 'containerDefinitions',
               'volumes', 'placementConstraints', 'requiresCompatibilities', 'cpu', 'memory', 'runtimePlatform', 'ephemeralStorage'}
    migration = {k: copy.deepcopy(v) for k, v in current.items() if k in allowed}
    migration['family'] = 'forms-api-v6-migrate'
    container = migration['containerDefinitions'][0]
    container['image'] = images[1]
    container['readonlyRootFilesystem'] = False
    container.pop('healthCheck', None)
    container['portMappings'] = []
    container['secrets'] = [{'name': 'DATABASE_URL', 'valueFrom': settings['ParameterPrefix'] + '/MIGRATION_DATABASE_URL'}]
    container['command'] = ['/bin/sh', '-c', 'pnpm migrate:deploy && pnpm exec prisma db execute --file deploy/grant-runtime.sql']
    migration_definition = ecs.register_task_definition(**migration)['taskDefinition']['taskDefinitionArn']
    service = ecs.describe_services(cluster=settings['ClusterName'], services=[output['ServiceName']])['services'][0]
    result = ecs.run_task(cluster=settings['ClusterName'], taskDefinition=migration_definition,
                          launchType='FARGATE', networkConfiguration=service['networkConfiguration'],
                          startedBy='forms-release')
    if result.get('failures') or not result.get('tasks'):
        raise RuntimeError('ECS could not start the migration task.')
    migration_arn = result['tasks'][0]['taskArn']
    print('Migration task: ' + migration_arn, flush=True)

    def migration_finished():
        """Read this migration task; return the stopped task, or None while live."""
        tasks = ecs.describe_tasks(cluster=settings['ClusterName'], tasks=[migration_arn])['tasks']
        if not tasks:
            raise RuntimeError('Migration task handle is missing; inspect ECS before retrying.')
        return tasks[0] if tasks[0]['lastStatus'] == 'STOPPED' else None

    completed = wait_until('migration task ' + migration_arn, migration_finished)
    if any(c.get('exitCode') != 0 for c in completed['containers']):
        raise RuntimeError('Migration failed; inspect /aws/ecs/forms-api-v6-' + environment + '. Runtime was not promoted.')
    parameters = [({'ParameterKey': x['ParameterKey'], 'ParameterValue': tag} if x['ParameterKey'] == 'ImageTag'
                   else {'ParameterKey': x['ParameterKey'], 'ParameterValue': str(max(1, int(settings['DesiredCount'])))} if x['ParameterKey'] == 'DesiredCount'
                   else {'ParameterKey': x['ParameterKey'], 'UsePreviousValue': True}) for x in stack['Parameters']]
    result = cfn.update_stack(StackName=stack_name, UsePreviousTemplate=True,
                             Parameters=parameters, Capabilities=['CAPABILITY_IAM'])
    print('Updating stack: ' + result['StackId'], flush=True)

    def stack_finished():
        """Read the same stack operation; return completed stack or raise on rollback."""
        state = cfn.describe_stacks(StackName=stack_name)['Stacks'][0]
        if state['StackStatus'] == 'UPDATE_COMPLETE':
            return state
        if state['StackStatus'] not in ('UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS'):
            raise RuntimeError('Stack promotion failed or rolled back: ' + state['StackStatus'])
        return None

    wait_until('CloudFormation promotion', stack_finished)
    live = ecs.describe_services(cluster=settings['ClusterName'], services=[output['ServiceName']])['services'][0]
    definition = ecs.describe_task_definition(taskDefinition=live['taskDefinition'])['taskDefinition']
    if definition['containerDefinitions'][0]['image'] != f'{repository}:{tag}' or live['runningCount'] < 1:
        raise RuntimeError('ECS did not retain the requested release.')
    evidence = {'environment': environment, 'tag': tag, 'runtimeImage': images[0], 'migrationImage': images[1],
                'migrationTask': migration_arn, 'taskDefinition': live['taskDefinition'], 'stack': stack_name}
    Path('deploy/release-' + environment + '.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
