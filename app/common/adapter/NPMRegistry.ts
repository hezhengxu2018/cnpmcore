import { setTimeout } from 'timers/promises';
import {
  ContextProto,
  AccessLevel,
  Inject,
} from '@eggjs/tegg';
import {
  EggLogger,
  EggContextHttpClient,
  EggAppConfig,
  HttpClientRequestOptions,
  HttpClientResponse,
} from 'egg';

type HttpMethod = HttpClientRequestOptions['method'];

const INSTANCE_NAME = 'npmRegistry';

export type RegistryResponse = { method: HttpMethod } & HttpClientResponse;

@ContextProto({
  name: INSTANCE_NAME,
  accessLevel: AccessLevel.PUBLIC,
})
export class NPMRegistry {
  @Inject()
  private readonly logger: EggLogger;
  @Inject()
  private readonly httpclient: EggContextHttpClient;
  @Inject()
  private config: EggAppConfig;
  private timeout = 10000;
  public registryHost: string;

  get registry(): string {
    return this.registryHost || this.config.cnpmcore.sourceRegistry;
  }

  public setRegistryHost(registryHost = '') {
    this.registryHost = registryHost;
  }

  public async getFullManifests(fullname: string, retries = 3): Promise<RegistryResponse> {
    // set query t=timestamp, make sure CDN cache disable
    // cache=0 is sync worker request flag
    const url = `${this.registry}/${encodeURIComponent(fullname)}?t=${Date.now()}&cache=0`;
    return await this.getManifest(url, {}, retries);
  }

  public async getAbbreviatedManifests(fullname: string, retries = 3): Promise<RegistryResponse> {
    const url = `${this.registry}/${encodeURIComponent(fullname)}?t=${Date.now()}&cache=0`;
    const headers = { Accept: 'application/vnd.npm.install-v1+json' };
    return await this.getManifest(url, headers, retries);
  }

  public async getPackageVersionManifest(fullname: string, versionOrTag: string, retries = 3) {
    const url = `${this.registry}/${encodeURIComponent(fullname)}/${versionOrTag}`;
    return await this.getManifest(url, {}, retries);
  }

  // app.put('/:name/sync', sync.sync);
  public async createSyncTask(fullname: string): Promise<RegistryResponse> {
    const url = `${this.registry}/${encodeURIComponent(fullname)}/sync?sync_upstream=true&nodeps=true`;
    // {
    //   ok: true,
    //   logId: logId
    // };
    return await this.request('PUT', url);
  }

  // app.get('/:name/sync/log/:id', sync.getSyncLog);
  public async getSyncTask(fullname: string, id: string, offset: number): Promise<RegistryResponse> {
    const url = `${this.registry}/${encodeURIComponent(fullname)}/sync/log/${id}?offset=${offset}`;
    // { ok: true, syncDone: syncDone, log: log }
    return await this.request('GET', url);
  }

  public async getDownloadRanges(registry: string, fullname: string, start: string, end: string): Promise<RegistryResponse> {
    const url = `${registry}/downloads/range/${start}:${end}/${encodeURIComponent(fullname)}`;
    return await this.request('GET', url);
  }

  private async request(method: HttpMethod, url: string, params?: object, options?: object): Promise<RegistryResponse> {
    const res = await this.httpclient.request(url, {
      method,
      data: params,
      dataType: 'json',
      timing: true,
      timeout: this.timeout,
      followRedirect: true,
      gzip: true,
      ...options,
    }) as HttpClientResponse;
    this.logger.info('[NPMRegistry:request] %s %s, status: %s', method, url, res.status);
    return {
      method,
      ...res,
    };
  }

  private async getManifest(url: string, headers = {}, retries = 3) {
    let lastError: any;
    while (retries > 0) {
      try {
        return await this.request('GET', url, undefined, { timeout: 120000, headers });
      } catch (err: any) {
        if (err.name === 'ResponseTimeoutError') throw err;
        lastError = err;
      }
      retries--;
      if (retries > 0) {
        // sleep 1s ~ 4s in random
        const delay = process.env.NODE_ENV === 'test' ? 1 : 1000 + Math.random() * 4000;
        await setTimeout(delay);
      }
    }
    throw lastError;
  }
}
