import assert from 'assert';
import { app, mock } from 'egg-mock/bootstrap';
import { TestUtil } from 'test/TestUtil';
import fs from 'fs/promises';
import { Registry as RegistryModel } from 'app/repository/model/Registry';
import { PackageManagerService } from 'app/core/service/PackageManagerService';
import { ProxyModeService } from 'app/core/service/ProxyModeService';
import { NFSClientAdapter } from 'app/infra/NFSClientAdapter';
import { NPMRegistry } from 'app/common/adapter/NPMRegistry';
import { calculateIntegrity } from 'app/common/PackageUtil';
import { PROXY_MODE_CACHED_PACKAGE_DIR_NAME } from 'app/common/constants';
import { DIST_NAMES } from 'app/core/entity/Package';

describe('test/core/service/ProxyModeService.test.ts', () => {
  let proxyModeService: ProxyModeService;
  let nfsClientAdapter: NFSClientAdapter;
  let npmRegistry: NPMRegistry;
  beforeEach(async () => {
    proxyModeService = await app.getEggObject(ProxyModeService);
    nfsClientAdapter = await app.getEggObject(NFSClientAdapter);
    npmRegistry = await app.getEggObject(NPMRegistry);
  });

  describe('initProxyModeRegistry()', () => {
    it('should return default source registry.', async () => {
      const registry = await proxyModeService.initProxyModeRegistry();
      assert(registry?.host === app.config.cnpmcore.sourceRegistry);
    });

    it('should insert default registry into database after init.', async () => {
      await proxyModeService.initProxyModeRegistry();
      const model = await RegistryModel.findOne({ name: 'default' });
      assert(model?.host === app.config.cnpmcore.sourceRegistry);
    });
  });

  describe('get package manifest', () => {

    it('should reject by block list when get full manifest', async () => {
      const name = 'cnpmcore-test-sync-blocklist';
      mock(app.config.cnpmcore, 'syncPackageBlockList', [ name ]);
      let error;
      try {
        await proxyModeService.getPackageFullManifests(name);
      } catch (err) {
        error = err;
      }
      assert(error.status === 403);
    });

    it('should reject by block list when get abbreviated manifest', async () => {
      const name = 'cnpmcore-test-sync-blocklist';
      mock(app.config.cnpmcore, 'syncPackageBlockList', [ name ]);
      let error;
      try {
        await proxyModeService.getPackageAbbreviatedManifests(name);
      } catch (err) {
        error = err;
      }
      assert(error.status === 403);
    });

    it('should get package full manifest from source registry and store it to NFS', async () => {
      app.mockHttpclient('https://registry.npmjs.org/foobar', 'GET', {
        data: await TestUtil.readFixturesFile('registry.npmjs.org/foobar.json'),
        persist: false,
      });
      const { data: fullManifest } = await proxyModeService.getPackageFullManifests('foobar');
      const storeKey = `/${PROXY_MODE_CACHED_PACKAGE_DIR_NAME}/foobar/${DIST_NAMES.FULL_MANIFESTS}`;
      const nfsBytes = await nfsClientAdapter.readBytes(storeKey);
      const fullManifestBytes = Buffer.from(JSON.stringify(fullManifest));
      assert((await calculateIntegrity(fullManifestBytes)).shasum === (await calculateIntegrity(nfsBytes!)).shasum);
    });

    it('should get package abbreviated manifest from source registry and store it to NFS', async () => {
      const data = await TestUtil.readFixturesFile('registry.npmjs.org/foobar.json');
      app.mockHttpclient('https://registry.npmjs.org/foobar', 'GET', (_, opt) => {
        assert(opt.headers.accept === 'application/vnd.npm.install-v1+json');
        return {
          data,
          persist: false,
        };
      });
      const { data: abbreviatedManifest } = await proxyModeService.getPackageAbbreviatedManifests('foobar');
      const storeKey = `/${PROXY_MODE_CACHED_PACKAGE_DIR_NAME}/foobar/${DIST_NAMES.ABBREVIATED_MANIFESTS}`;
      const nfsBytes = await nfsClientAdapter.readBytes(storeKey);
      const fullManifestBytes = Buffer.from(JSON.stringify(abbreviatedManifest));
      assert((await calculateIntegrity(fullManifestBytes)).shasum === (await calculateIntegrity(nfsBytes!)).shasum);
    });

    it('should get abbreviated menifest from NFS instead of source registry', async () => {
      const storeKey = `/${PROXY_MODE_CACHED_PACKAGE_DIR_NAME}/foobar/${DIST_NAMES.ABBREVIATED_MANIFESTS}`;
      mock(nfsClientAdapter, 'readBytes', async sk => {
        if (sk === storeKey) {
          const nfsJson = { message: 'mock abbreviated package.json in NFS' };
          return Buffer.from(JSON.stringify(nfsJson));
        }
      });
      mock(npmRegistry, 'getAbbreviatedManifests', async () => {
        throw new Error('this func should not be called.');
      });
      const { data: abbreviatedManifest } = await proxyModeService.getPackageAbbreviatedManifests('foobar');
      assert(abbreviatedManifest.message === 'mock abbreviated package.json in NFS');
    });

    it('should get full menifest from NFS instead of source registry', async () => {
      const storeKey = `/${PROXY_MODE_CACHED_PACKAGE_DIR_NAME}/foobar/${DIST_NAMES.FULL_MANIFESTS}`;
      mock(nfsClientAdapter, 'readBytes', async sk => {
        if (sk === storeKey) {
          const nfsJson = { message: 'mock full package.json in NFS' };
          return Buffer.from(JSON.stringify(nfsJson));
        }
      });
      mock(npmRegistry, 'getFullManifests', async () => {
        throw new Error('this func should not be called.');
      });
      const { data: abbreviatedManifest } = await proxyModeService.getPackageFullManifests('foobar');
      assert(abbreviatedManifest.message === 'mock full package.json in NFS');
    });
  });

  describe('getPackageVersionOrTagManifest()', () => {
    let name;
    let version;
    let pkg;

    beforeEach(async () => {
      name = '@cnpm/testmodule';
      version = '0.0.1';
      const abbreJSONFile = TestUtil.getFixtures('exampleAbbreviatedPackage.json');
      pkg = JSON.parse((await fs.readFile(abbreJSONFile)).toString());
      mock(proxyModeService, 'getPackageAbbreviatedManifests', async () => {
        return { data: pkg, etag: '', blockReason: '' };
      });
      app.mockHttpclient(`${app.config.cnpmcore.sourceRegistry}/${encodeURIComponent(name)}/${version}`, {
        data: { message: 'mock package.json' },
      });
    });

    it('should get package version info from source registry', async () => {
      const manifest = await proxyModeService.getPackageVersionOrTagManifest(name, version);
      assert(manifest.message === 'mock package.json');
    });

    it('should get package version info from NFS when it is exist in NFS', async () => {
      const name = '@cnpm/testmodule';
      const version = '0.0.1';
      const storeKey = `/${PROXY_MODE_CACHED_PACKAGE_DIR_NAME}/${name}/${version}/${DIST_NAMES.MANIFEST}`;
      mock(nfsClientAdapter, 'readBytes', async sk => {
        if (sk === storeKey) {
          const nfsJson = { message: 'mock package.json in NFS' };
          return Buffer.from(JSON.stringify(nfsJson));
        }
      });
      const manifest = await proxyModeService.getPackageVersionOrTagManifest(name, version);
      assert(manifest.message === 'mock package.json in NFS');
    });

    it('should throw JSON prase Error when NFS file prase failed and remove file', async () => {
      const name = '@cnpm/testmodule';
      const version = '0.0.1';
      const storeKey = `/${PROXY_MODE_CACHED_PACKAGE_DIR_NAME}/${name}/${version}/${DIST_NAMES.MANIFEST}`;
      mock(nfsClientAdapter, 'readBytes', async sk => {
        if (sk === storeKey) {
          return Buffer.from('a string can not be prase.');
        }
      });
      const tracker = new assert.CallTracker();
      const spyFunc = async () => {
        return '';
      };
      mock(nfsClientAdapter, 'remove', spyFunc);
      const callsfunc = tracker.calls(spyFunc, 1);
      callsfunc();
      let error;
      try {
        await proxyModeService.getPackageVersionOrTagManifest(name, version);
      } catch (err) {
        error = err;
      }
      assert(error.status === 500);
      assert(error.options.message === 'manifest in NFS JSON parse error');
      tracker.verify();
    });
  });

  describe('getPackageVersionTarAndTempFilePath()', () => {
    let tgzBuffer: Buffer;
    let resBuffer: Buffer | null;
    let packageManagerService: PackageManagerService;
    beforeEach(async () => {
      packageManagerService = await app.getEggObject(PackageManagerService);
      tgzBuffer = await TestUtil.readFixturesFile('registry.npmjs.org/foobar/-/foobar-1.0.0.tgz');
      app.mockHttpclient('https://registry.npmjs.org/foobar/-/foobar-1.0.0.tgz', 'GET', {
        data: tgzBuffer,
        persist: false,
      });
      app.mockHttpclient('https://registry.npmjs.org/foobar', 'GET', {
        data: await TestUtil.readFixturesFile('registry.npmjs.org/foobar.json'),
        persist: false,
      });
      resBuffer = await proxyModeService.getPackageVersionTarAndTempFilePath('foobar', '1.0.0', 'foobar/-/foobar-1.0.0.tgz');
    });

    it('should reject by block list', async () => {
      const name = 'cnpmcore-test-sync-blocklist';
      mock(app.config.cnpmcore, 'syncPackageBlockList', [ name ]);
      let error;
      try {
        await proxyModeService.getPackageVersionTarAndTempFilePath(name, '1.0.0', `${name}/-/${name}-1.0.0.tgz`);
      } catch (err) {
        error = err;
      }
      assert(error.status === 403);
    });

    it('should get the tgz buffer from source registry', async () => {
      assert((await calculateIntegrity(resBuffer!)).shasum === (await calculateIntegrity(tgzBuffer)).shasum);
    });

    it('should publish the specified version to database', async () => {
      const { data: manifests } = await packageManagerService.listPackageFullManifests('', 'foobar');
      assert(manifests);
      assert(manifests.versions['1.0.0']);
      assert(Object.keys(manifests.versions).length === 1);
    });

    it('should sync maintainers when publish', async () => {
      const { data: manifests } = await packageManagerService.listPackageFullManifests('', 'foobar');
      const sourceManifests = JSON.parse((await TestUtil.readFixturesFile('registry.npmjs.org/foobar.json')).toString('utf8'));
      assert(manifests.maintainers.length >= 1);
      assert.deepEqual(manifests.maintainers, sourceManifests.maintainers);
    });

    it('should sync dist-tags when publish', async () => {
      const { data: manifests } = await packageManagerService.listPackageFullManifests('', 'foobar');
      const sourceManifests = JSON.parse((await TestUtil.readFixturesFile('registry.npmjs.org/foobar.json')).toString('utf8'));
      assert(Object.keys(manifests['dist-tags']).length >= 1);
      assert.deepEqual(manifests['dist-tags'], sourceManifests['dist-tags']);
    });
  });
});
