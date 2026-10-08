import { HttpProcessSession, HttpTransport, type HttpConnectionOptions, type RemoteProcessSpec } from './files/index';
import { FSError, type OperationOptions } from '@itookit/vfs-core';
import type { ProjectClient, RemoteProject } from './projects';

/** Reuse process cancellation and reaping, replacing only project admission. */
export function createProjectProcess(config: HttpConnectionOptions, projects: ProjectClient, project: RemoteProject, spec: RemoteProcessSpec) {
    const granted = [{alias:project.alias,path:project.path,at:'/workspace',access:project.access},...project.mounts];
    const requested = spec.mounts.map(mount => ({...mount}));
    const attenuated = granted.map(mount => ({...mount,access:'ro' as const}));
    const equal = (a: typeof granted, b: typeof granted) => JSON.stringify([...a].sort((x,y) => x.at.localeCompare(y.at)).map(m => [m.alias,m.path,m.at,m.access])) === JSON.stringify([...b].sort((x,y) => x.at.localeCompare(y.at)).map(m => [m.alias,m.path,m.at,m.access]));
    const readOnly = equal(requested,attenuated);
    if (!readOnly && !equal(requested,granted)) throw new FSError('EACCES','Project mount grants differ from the server policy');
    class ProjectTransport extends HttpTransport {
        async json<T>(route: string, init: RequestInit = {}, options?: OperationOptions, maxBytes?: number): Promise<T> {
            if (route !== 'v1/processes' || init.method !== 'POST') return super.json(route,init,options,maxBytes);
            const input = JSON.parse(String(init.body)) as Parameters<ProjectClient['exec']>[1];
            return await projects.exec(project,{...input,readOnly},options) as T;
        }
    }
    const owner = new HttpProcessSession(new ProjectTransport(config),spec);
    return {nativeShell:owner.nativeShell,release:async () => {try {await owner.release();}finally{await projects.close();}}};
}
