#!/usr/bin/env python3
"""Start a bootstrapped service and verify the image deployed by master_deploy.sh.

Run after successful migrations and shared runtime deployment. Reads the shared
AWS_ECS_* deployvars and CIRCLE_BUILD_NUM; keeps existing nonzero replica counts.
"""
import os

import boto3

from release import wait_until


def activate_service(ecs, cluster, service_name, expected_image):
    """Activate and observe the requested runtime using an ECS client and identifiers.

    Returns the stable service. Raises on missing services, an unexpected image,
    rollback, failed deployment, AWS errors, or observation timeout. Only a service
    already referencing expected_image can be scaled from zero to one.
    """
    def read_service():
        """Return the named active ECS service or raise if it is unavailable."""
        result = ecs.describe_services(cluster=cluster, services=[service_name])
        if result.get('failures') or len(result.get('services', [])) != 1:
            raise RuntimeError('The deployment service could not be found.')
        service = result['services'][0]
        if service['status'] != 'ACTIVE':
            raise RuntimeError('The deployment service is not active.')
        return service

    service = read_service()
    definition_arn = service['taskDefinition']
    definition = ecs.describe_task_definition(taskDefinition=definition_arn)['taskDefinition']
    container = next(c for c in definition['containerDefinitions'] if c['name'] == 'forms-api-v6')
    if container['image'] != expected_image:
        raise RuntimeError('Shared deployment did not promote the requested runtime image.')
    if service['desiredCount'] == 0:
        ecs.update_service(cluster=cluster, service=service_name, desiredCount=1)
        print('Started the bootstrapped Forms service with one replica.', flush=True)

    def is_stable():
        """Return the healthy service when converged; reject rollback or failure."""
        current = read_service()
        if current['taskDefinition'] != definition_arn:
            raise RuntimeError('ECS rolled back or replaced the requested runtime.')
        deployments = current['deployments']
        if any(d.get('rolloutState') == 'FAILED' for d in deployments):
            raise RuntimeError('ECS runtime deployment failed.')
        if (len(deployments) == 1 and deployments[0].get('rolloutState') == 'COMPLETED'
                and current['runningCount'] == current['desiredCount'] > 0
                and current['pendingCount'] == 0):
            arns = ecs.list_tasks(cluster=cluster, serviceName=service_name,
                                  desiredStatus='RUNNING')['taskArns']
            if arns:
                tasks = ecs.describe_tasks(cluster=cluster, tasks=arns)['tasks']
                healthy = [task for task in tasks
                           if task['taskDefinitionArn'] == definition_arn
                           and task.get('healthStatus') == 'HEALTHY'
                           and task['lastStatus'] == 'RUNNING']
                if len(healthy) >= current['desiredCount']:
                    return current
        return None

    return wait_until('requested Forms runtime to become stable', is_stable)


def main():
    """Read CircleCI/deployvar settings and activate the expected image; errors propagate."""
    session = boto3.Session(region_name=os.environ.get('AWS_REGION', 'us-east-1'))
    account = session.client('sts').get_caller_identity()['Account']
    image = (f'{account}.dkr.ecr.{session.region_name}.amazonaws.com/'
             f'{os.environ["AWS_REPOSITORY"]}:{os.environ["CIRCLE_BUILD_NUM"]}')
    service = activate_service(session.client('ecs'), os.environ['AWS_ECS_CLUSTER'],
                               os.environ['AWS_ECS_SERVICE'], image)
    print('Verified running release: ' + service['taskDefinition'], flush=True)


if __name__ == '__main__':
    main()
