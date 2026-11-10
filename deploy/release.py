#!/usr/bin/env python3
"""Scan both images, run the one-shot migration, then promote/activate Forms."""
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import tempfile
import time

sys.path.insert(0, '/tmp/tc-deploy-scripts')
import tcdeploy as d


def wait_until(description, check, seconds=900):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(10)
    raise d.DeployError('Timed out: ' + description)


def stack_settings(aws, m):
    environment = 'production' if m['environment'] == 'prod' else 'dev'
    stack_name = 'forms-api-v6-' + environment
    stacks = aws.call('cloudformation', 'describe-stacks', StackName=stack_name).get('Stacks', [])
    d.require(len(stacks) == 1, 'Expected the existing Forms stack')
    stack = stacks[0]
    d.require(stack.get('StackStatus') in ('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'), 'Forms stack is not stable')
    settings = {v['ParameterKey']: v['ParameterValue'] for v in stack.get('Parameters', [])}
    output = {v['OutputKey']: v['OutputValue'] for v in stack.get('Outputs', [])}
    d.require(settings.get('Environment') == environment and settings.get('BootstrapOnly') == 'false', 'Complete Forms infrastructure bootstrap before releasing')
    d.require(settings.get('ClusterName') == m['cluster'] and output.get('ServiceName') == m['service'], 'Forms stack target differs from manifest')
    d.require(settings.get('ParameterPrefix') == '/config/forms-api-v6/appvar', 'Unexpected migration secret namespace')
    d.require(output.get('RepositoryUri') == f"{m['accountId']}.dkr.ecr.{m['region']}.amazonaws.com/forms-api-v6", 'Unexpected Forms repository')
    return settings


def read_service(aws, m):
    result = aws.call('ecs', 'describe-services', cluster=m['cluster'], services=[m['service']])
    d.require(not result.get('failures') and len(result.get('services', [])) == 1, 'Expected the existing Forms service')
    service = result['services'][0]
    d.require(service.get('status') == 'ACTIVE' and service.get('desiredCount', -1) >= 0, 'Forms service is not active')
    d.require(service.get('serviceArn') == d.arn(m, 'ecs', f"service/{m['cluster']}/{m['service']}"), 'Unexpected service ARN')
    d.require(service.get('deploymentController', {}).get('type', 'ECS') == 'ECS', 'Forms requires ECS rolling deployment')
    breaker = service.get('deploymentConfiguration', {}).get('deploymentCircuitBreaker')
    d.require(isinstance(breaker, dict) and breaker.get('enable') is True and breaker.get('rollback') is True, 'Enable Forms circuit-breaker rollback')
    return service


def initial_stable(service, definition):
    d.require(service.get('taskDefinition') == definition, 'Concurrent Forms deployment detected')
    deployments = service.get('deployments', [])
    d.require(not any(x.get('rolloutState') == 'FAILED' for x in deployments), 'Forms rollout failed')
    return (len(deployments) == 1 and deployments[0].get('rolloutState') == 'COMPLETED'
            and deployments[0].get('taskDefinition') == definition
            and service.get('runningCount') == service['desiredCount']
            and service.get('pendingCount') == 0)


def migration_request(m, task, tags, image):
    # Validate exact roles, runtime settings, health checks and secret references
    # before deriving a separate one-shot definition from this service.
    request = d.task_request(m, task, tags, {'forms-api-v6': image})
    request['family'] = 'forms-api-v6-migrate'
    containers = request['containerDefinitions']
    d.require(len(containers) == 1 and containers[0]['name'] == 'forms-api-v6', 'Unexpected Forms containers')
    container = containers[0]
    container['readonlyRootFilesystem'] = False
    container.pop('healthCheck', None)
    container['portMappings'] = []
    container['secrets'] = [{'name': 'DATABASE_URL', 'valueFrom': '/config/forms-api-v6/appvar/MIGRATION_DATABASE_URL'}]
    container['environment'] = [v for v in container.get('environment', []) if v['name'] != 'DATABASE_URL']
    container['command'] = ['node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy']
    return request


def migrate(aws, m, service, task, tags, image):
    request = migration_request(m, task, tags, image)
    definition = aws.call('ecs', 'register-task-definition', **request)['taskDefinition']['taskDefinitionArn']
    d.require(definition.startswith(d.arn(m, 'ecs', 'task-definition/forms-api-v6-migrate:')), 'Unexpected migration family')
    result = aws.call('ecs', 'run-task', cluster=m['cluster'], taskDefinition=definition,
        launchType='FARGATE', networkConfiguration=service['networkConfiguration'], startedBy='forms-release')
    d.require(not result.get('failures') and len(result.get('tasks', [])) == 1, 'Migration task could not start')
    task_arn = result['tasks'][0]['taskArn']

    def stopped():
        result = aws.call('ecs', 'describe-tasks', cluster=m['cluster'], tasks=[task_arn])
        d.require(not result.get('failures') and len(result.get('tasks', [])) == 1, 'Migration task is missing')
        current = result['tasks'][0]
        d.require(current.get('taskDefinitionArn') == definition, 'Migration task revision differs')
        return current if current.get('lastStatus') == 'STOPPED' else None

    completed = wait_until('Forms migration', stopped)
    containers = completed.get('containers', [])
    d.require(len(containers) == 1 and containers[0].get('exitCode') == 0
              and containers[0].get('imageDigest') == image.rsplit('@', 1)[1],
              'Migration failed or executed an unexpected image; runtime was not promoted')
    return task_arn


def promote(aws, m, previous, task, tags, image):
    d.require(initial_stable(read_service(aws, m), previous['taskDefinition']), 'Service changed during migration')
    request = d.task_request(m, task, tags, {'forms-api-v6': image})
    definition = aws.call('ecs', 'register-task-definition', **request)['taskDefinition']['taskDefinitionArn']
    d.require(definition.startswith(d.arn(m, 'ecs', 'task-definition/' + m['taskFamily'] + ':')), 'Unexpected runtime family')
    saved = aws.call('ecs', 'describe-task-definition', taskDefinition=definition, include=['TAGS'])
    actual = {k: v for k, v in saved['taskDefinition'].items() if k in d.TASK_FIELDS}
    actual['tags'] = sorted(saved.get('tags', []), key=lambda x: x['key'])
    expected = deepcopy(request)
    expected['tags'] = sorted(expected.get('tags', []), key=lambda x: x['key'])
    d.require(actual == expected, 'Registered Forms runtime differs from the requested definition')
    d.require(initial_stable(read_service(aws, m), previous['taskDefinition']), 'Concurrent Forms release before activation')
    updated = aws.call('ecs', 'update-service', cluster=m['cluster'], service=m['service'],
                       taskDefinition=definition, desiredCount=max(1, previous['desiredCount']))
    d.require(updated.get('service', {}).get('taskDefinition') == definition, 'ECS did not accept the Forms revision')

    def healthy():
        current = d.read_service(aws, m)
        return (d.stable(current, definition) and
                d.verify_running(aws, m, definition, {'forms-api-v6': image}, current['desiredCount']))

    wait_until('healthy Forms runtime', healthy, seconds=1200)
    return definition


def release(aws, m, publisher, release_tag):
    stack_settings(aws, m)
    previous = read_service(aws, m)
    d.require(initial_stable(previous, previous['taskDefinition']), 'Forms must be stable before release')
    response = aws.call('ecs', 'describe-task-definition', taskDefinition=previous['taskDefinition'], include=['TAGS'])
    task, tags = response['taskDefinition'], response.get('tags', [])
    migration_request(m, task, tags, 'preflight@sha256:' + '0' * 64)
    # Each image gets its own scan budget after upload and digest verification.
    runtime = publisher.publish('forms-api-v6', 'forms-api-v6:candidate', release_tag)
    migration = publisher.publish('forms-api-v6', 'forms-api-v6:migrate-candidate', release_tag + '-migrate')
    d.require(initial_stable(read_service(aws, m), previous['taskDefinition']), 'Service changed during image publication')
    migration_task = migrate(aws, m, previous, task, tags, migration)
    definition = promote(aws, m, previous, task, tags, runtime)
    return {'service': m['service'], 'taskDefinition': definition, 'migrationTask': migration_task, 'image': runtime}


def main():
    m = d.read_manifest(sys.argv[1])
    d.require(m['service'] == 'forms-api-v6' and set(m['images']) == {'forms-api-v6'}, 'Expected Forms manifest')
    d.require(os.environ.get('CIRCLE_BRANCH') == m['branch'] and not os.environ.get('CIRCLE_TAG'), 'Wrong deployment branch')
    d.require(os.environ.get('CIRCLE_PROJECT_USERNAME', '') + '/' + os.environ.get('CIRCLE_PROJECT_REPONAME', '') == m['repository'].removeprefix('github.com/'), 'Wrong deployment repository')
    tag = os.environ.get('CIRCLE_SHA1', '') + '-' + os.environ.get('CIRCLE_BUILD_NUM', '')
    d.require(d.re.fullmatch(r'[a-f0-9]{40}-[0-9]{1,12}', tag), 'Invalid release identity')
    aws = d.authenticate(m, os.environ.get('CIRCLE_OIDC_TOKEN_V3'), ['ecs:RunTask', 'cloudformation:DescribeStacks'])
    with tempfile.TemporaryDirectory(prefix='forms-release-') as directory:
        result = release(aws, m, d.Publisher(aws, m, directory), tag)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except (d.DeployError, ValueError, KeyError, TypeError, OSError, IndexError):
        print('Forms release stopped; inspect the migration or ECS rollout. No secret values were fetched.', file=sys.stderr)
        sys.exit(1)
