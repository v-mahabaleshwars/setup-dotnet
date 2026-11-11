import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import path from 'path';
import type {QualityOptions} from '../src/setup-dotnet.js';

const getJson = jest.fn<() => Promise<{statusCode: number; result: unknown}>>();
const dispose = jest.fn();
const getExecOutput =
  jest.fn<
    (
      ...args: unknown[]
    ) => Promise<{exitCode: number; stdout: string; stderr: string}>
  >();
const warning = jest.fn();
const addPath = jest.fn();
const exportVariable = jest.fn();
const installed = new Map<string, string[]>();
const missingFiles = new Set<string>();
let platform: 'linux' | 'mac' | 'windows' = 'linux';
let muxerAvailable = true;

jest.unstable_mockModule('@actions/core', () => ({
  warning,
  info: jest.fn(),
  debug: jest.fn(),
  addPath,
  exportVariable
}));
jest.unstable_mockModule('@actions/http-client', () => ({
  HttpClient: jest.fn(() => ({getJson, dispose}))
}));
jest.unstable_mockModule('@actions/exec', () => ({getExecOutput}));
jest.unstable_mockModule('@actions/io', () => ({
  which: jest.fn(async () => 'shell')
}));
jest.unstable_mockModule('../src/utils.js', () => ({
  PLATFORM: platform,
  IS_WINDOWS: platform === 'windows'
}));
jest.unstable_mockModule('os', () => ({
  default: {arch: () => 'x64', homedir: () => '/home/runner'}
}));
jest.unstable_mockModule('fs', () => {
  const actual = jest.requireActual('fs') as typeof import('fs');
  return {
    ...actual,
    chmodSync: jest.fn(),
    lstatSync: jest.fn(() => ({isDirectory: () => true})),
    mkdtempSync: jest.fn((prefix: string) => `${prefix}test`),
    rmSync: jest.fn(),
    readdirSync: jest.fn((dir: string) =>
      (installed.get(path.basename(dir)) || []).map(name => ({
        name,
        isDirectory: () => true,
        isSymbolicLink: () => false
      }))
    ),
    statSync: jest.fn((file: string) => ({
      isFile: () =>
        !missingFiles.has(file) &&
        (!['dotnet', 'dotnet.exe'].includes(path.basename(file)) ||
          muxerAvailable)
    })),
    accessSync: jest.fn(() => {
      if (!muxerAvailable) throw new Error('not executable');
    })
  };
});

describe.each(['linux', 'mac', 'windows'] as const)(
  'runtime installation on %s',
  target => {
    let installer: typeof import('../src/installer.js');
    const originalEnv = process.env;

    beforeEach(async () => {
      platform = target;
      process.env = {
        ...originalEnv,
        HOME: '/home/runner',
        PROGRAMFILES: '/Program Files'
      };
      delete process.env['DOTNET_INSTALL_DIR'];
      delete process.env['DOTNET_ROOT'];
      installed.clear();
      missingFiles.clear();
      muxerAvailable = true;
      jest.resetAllMocks();
      jest.resetModules();
      getJson.mockRejectedValue(new Error('Unexpected HTTP request'));
      getExecOutput.mockImplementation(async (...args) => {
        const scriptArgs = args[1] as string[];
        const index = scriptArgs.findIndex(
          arg => arg === '--version' || arg === '-Version'
        );
        return {
          exitCode: 0,
          stdout: `Installed version is ${index < 0 ? '8.0.11' : scriptArgs[index + 1]}`,
          stderr: ''
        };
      });
      installer = await import('../src/installer.js');
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    const runtimeArgs = () =>
      getExecOutput.mock.calls.map(call => call[1] as string[]);
    const flag = (name: string) =>
      target === 'windows' ? `-${name}` : `--${name.toLowerCase()}`;
    const installPair = (versions: string[]) => {
      installed.set('Microsoft.NETCore.App', versions);
      installed.set('Microsoft.AspNetCore.App', versions);
    };

    it('initializes the native install directory before executing and exporting PATH', async () => {
      getExecOutput.mockImplementation(async (...args) => {
        const options = args[2] as {env: NodeJS.ProcessEnv};
        expect(options.env.DOTNET_INSTALL_DIR).toBe(
          installer.DotnetInstallDir.dirPath
        );
        return {exitCode: 0, stdout: 'Installed version is 8.0.11', stderr: ''};
      });
      await new installer.DotnetCoreInstaller('8.0.11', '').installRuntime();
      installer.DotnetInstallDir.addToPath();
      expect(addPath).toHaveBeenCalledWith(installer.DotnetInstallDir.dirPath);
      expect(exportVariable).toHaveBeenCalledWith(
        'DOTNET_ROOT',
        installer.DotnetInstallDir.dirPath
      );
      expect(getJson).not.toHaveBeenCalled();
    });

    it('normalizes an explicit relative install directory', async () => {
      process.env['DOTNET_INSTALL_DIR'] = 'runtime target';
      await new installer.DotnetCoreInstaller('8.0.11', '').installRuntime();
      expect(process.env['DOTNET_INSTALL_DIR']).toBe(
        path.resolve('runtime target')
      );
    });

    it('keeps cross-architecture installs online and quotes Windows paths', async () => {
      installPair(['8.0.11']);
      await new installer.DotnetCoreInstaller(
        '8.0.x',
        '',
        'arm64',
        undefined,
        false
      ).installRuntime();
      const dir = path.join(installer.DotnetInstallDir.dirPath, 'arm64');
      expect(runtimeArgs()).toHaveLength(2);
      for (const args of runtimeArgs()) {
        expect(args).toContain(
          target === 'windows' ? '-InstallDir' : '--install-dir'
        );
        expect(args).toContain(target === 'windows' ? `"${dir}"` : dir);
      }
    });

    it.each([
      ['8.0.0-rc.2.23479.6', '8.0.0-rc.2.23480.2'],
      ['3.1.0-preview3.19553.2', '3.1.0-preview3.19555.2'],
      ['2.1.0-preview1-26216-03', '2.1.0-preview1-final']
    ])(
      'pairs exact runtime %s with ASP.NET Core %s before running scripts',
      async (base, aspnet) => {
        getJson.mockImplementation(async () => {
          expect(getExecOutput).not.toHaveBeenCalled();
          return {
            statusCode: 200,
            result: {
              releases: [
                {runtime: null},
                {
                  runtime: {version: base},
                  'aspnetcore-runtime': {version: aspnet}
                }
              ]
            }
          };
        });
        const result = await new installer.DotnetCoreInstaller(
          base,
          ''
        ).installRuntime();
        expect(result).toBe(base);
        expect(runtimeArgs()[0]).toEqual(
          expect.arrayContaining([flag('Version'), base])
        );
        expect(runtimeArgs()[1]).toEqual(
          expect.arrayContaining([flag('Version'), aspnet])
        );
        expect(getJson).toHaveBeenCalledTimes(1);
        expect(dispose).toHaveBeenCalledTimes(1);
      }
    );

    it.each([
      {statusCode: 404, result: null},
      {statusCode: 200, result: {releases: []}},
      {statusCode: 200, result: {releases: 'invalid'}},
      {
        statusCode: 200,
        result: {
          releases: [
            {
              runtime: {version: '8.0.0-preview.1'},
              'aspnetcore-runtime': {version: 'invalid'}
            }
          ]
        }
      },
      {
        statusCode: 200,
        result: {
          releases: [
            {
              runtime: {version: '8.0.0-preview.2'},
              'aspnetcore-runtime': {version: '8.0.0-preview.2'}
            }
          ]
        }
      }
    ])(
      'warns and preserves unpublished exact versions for metadata response %j',
      async response => {
        getJson.mockResolvedValue(response);
        await new installer.DotnetCoreInstaller(
          '8.0.0-preview.1',
          ''
        ).installRuntime();
        expect(runtimeArgs()[1]).toContain('8.0.0-preview.1');
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining('No ASP.NET Core release mapping')
        );
      }
    );

    it('reports metadata network failures and still lets the installer try the exact build', async () => {
      getJson.mockRejectedValue(new Error('metadata unavailable'));
      await new installer.DotnetCoreInstaller(
        '12.0.0-alpha.1',
        ''
      ).installRuntime();
      expect(runtimeArgs()[1]).toContain('12.0.0-alpha.1');
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('metadata unavailable')
      );
    });

    it('keeps ASP.NET Core installer failures fatal after resolving a pairing', async () => {
      getJson.mockResolvedValue({
        statusCode: 200,
        result: {
          releases: [
            {
              runtime: {version: '8.0.0-rc.2.23479.6'},
              'aspnetcore-runtime': {version: '8.0.0-rc.2.23480.2'}
            }
          ]
        }
      });
      getExecOutput
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '8.0.0-rc.2.23479.6',
          stderr: ''
        })
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: '',
          stderr: 'download failed'
        });
      await expect(
        new installer.DotnetCoreInstaller(
          '8.0.0-rc.2.23479.6',
          ''
        ).installRuntime()
      ).rejects.toThrow(
        'Failed to install aspnetcore runtime, exit code: 1. download failed'
      );
    });

    it.each(['1', '1.1', '1.1.13', '2.0', '2.0.9'])(
      'skips nonexistent shared ASP.NET Core for %s',
      async version => {
        await new installer.DotnetCoreInstaller(version, '').installRuntime();
        expect(runtimeArgs()).toHaveLength(1);
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining('not available before .NET Core 2.1')
        );
        expect(getJson).not.toHaveBeenCalled();
      }
    );

    it.each(['2', '2.1', '8.0.11', '8.0.x'])(
      'preserves both framework installs without metadata for %s',
      async version => {
        await new installer.DotnetCoreInstaller(version, '').installRuntime();
        expect(runtimeArgs()).toHaveLength(2);
        expect(getJson).not.toHaveBeenCalled();
      }
    );

    it('warns once with runtime wording when quality is ignored', async () => {
      await new installer.DotnetCoreInstaller(
        '8.0.11',
        'preview'
      ).installRuntime();
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('.NET runtime channels')
      );
      for (const args of runtimeArgs())
        expect(args).not.toContain(flag('Quality'));
    });

    it.each([
      ['8.0.11', '', undefined, '8.0.11'],
      ['8.0.x', '', undefined, '8.0.12'],
      ['8', '', undefined, '8.0.12'],
      ['latest', '', undefined, '9.0.1'],
      ['latest', '', '8.0', '8.0.12'],
      ['8.0.x', 'preview', undefined, '8.0.0-preview.1']
    ] as [string, QualityOptions, string | undefined, string][])(
      'reuses complete pairs for %s quality=%s channel=%s without HTTP or scripts',
      async (version, quality, channel, expected) => {
        installPair([
          '8.0.11',
          '8.0.12',
          '9.0.1',
          '8.0.0-preview.1',
          'not-a-version'
        ]);
        expect(
          await new installer.DotnetCoreInstaller(
            version,
            quality,
            'amd64',
            channel,
            false
          ).installRuntime()
        ).toBe(expected);
        expect(getExecOutput).not.toHaveBeenCalled();
        expect(getJson).not.toHaveBeenCalled();
      }
    );

    it('reuses runtimes installed by an SDK without interpreting the SDK version as a runtime version', async () => {
      getExecOutput.mockImplementation(async () => {
        installPair(['8.0.11']);
        return {
          exitCode: 0,
          stdout: 'Installed version is 8.0.404',
          stderr: ''
        };
      });
      await new installer.DotnetCoreInstaller(
        '8.0.404',
        '',
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        true
      ).installDotnet();
      getExecOutput.mockClear();
      expect(
        await new installer.DotnetCoreInstaller(
          '8.0.x',
          '',
          undefined,
          undefined,
          false
        ).installRuntime()
      ).toBe('8.0.11');
      expect(getExecOutput).not.toHaveBeenCalled();
      expect(getJson).not.toHaveBeenCalled();
    });

    it('can reuse the base runtime alone before 2.1', async () => {
      installed.set('Microsoft.NETCore.App', ['1.1.13']);
      expect(
        await new installer.DotnetCoreInstaller(
          '1',
          '',
          undefined,
          undefined,
          false
        ).installRuntime()
      ).toBe('1.1.13');
      expect(getExecOutput).not.toHaveBeenCalled();
    });

    it.each(['missing-framework', 'missing-deps', 'missing-muxer', 'no-match'])(
      'falls back online for %s',
      async problem => {
        installPair(['8.0.11']);
        if (problem === 'missing-framework')
          installed.delete('Microsoft.AspNetCore.App');
        if (problem === 'missing-deps')
          missingFiles.add(
            path.join(
              installer.DotnetInstallDir.dirPath,
              'shared',
              'Microsoft.AspNetCore.App',
              '8.0.11',
              'Microsoft.AspNetCore.App.deps.json'
            )
          );
        if (problem === 'missing-muxer') muxerAvailable = false;
        await new installer.DotnetCoreInstaller(
          problem === 'no-match' ? '9.0.x' : '8.0.x',
          '',
          undefined,
          undefined,
          false
        ).installRuntime();
        expect(runtimeArgs()).toHaveLength(2);
      }
    );

    it('does not reuse a local pair when check-latest is true', async () => {
      installPair(['8.0.11']);
      await new installer.DotnetCoreInstaller('8.0.x', '').installRuntime();
      expect(runtimeArgs()).toHaveLength(2);
    });

    it.each(['LTS', 'STS'])(
      'resolves latest with %s online even with a local pair',
      async channel => {
        installPair(['8.0.11']);
        getJson.mockResolvedValue({
          statusCode: 200,
          result: {
            'releases-index': [
              {
                'channel-version': '8.0',
                'support-phase': 'active',
                'release-type': channel.toLowerCase()
              }
            ]
          }
        });
        await new installer.DotnetCoreInstaller(
          'latest',
          '',
          undefined,
          channel,
          false
        ).installRuntime();
        expect(getJson).toHaveBeenCalledTimes(1);
        for (const args of runtimeArgs())
          expect(args).toEqual(
            expect.arrayContaining([flag('Channel'), '8.0'])
          );
      }
    );

    it('still rejects feature-band runtime versions before HTTP or scripts', async () => {
      installPair(['8.0.100']);
      await expect(
        new installer.DotnetCoreInstaller(
          '8.0.1xx',
          '',
          undefined,
          '8.0.1xx',
          false
        ).installRuntime()
      ).rejects.toThrow(/feature band/);
      expect(getJson).not.toHaveBeenCalled();
      expect(getExecOutput).not.toHaveBeenCalled();
    });

    it.each([true, false])(
      'ignores SDK-only channels for runtime latest without failing (check-latest: %s)',
      async checkLatest => {
        installPair(['8.0.100']);
        getJson.mockResolvedValue({
          statusCode: 200,
          result: {
            'releases-index': [
              {
                'channel-version': '9.0',
                'support-phase': 'active',
                'release-type': 'sts'
              }
            ]
          }
        });
        await new installer.DotnetCoreInstaller(
          'latest',
          '',
          undefined,
          '8.0.1xx',
          checkLatest
        ).installRuntime();
        expect(getJson).toHaveBeenCalledTimes(1);
        expect(runtimeArgs()).toHaveLength(2);
        for (const args of runtimeArgs()) {
          expect(args).toEqual(
            expect.arrayContaining([flag('Channel'), '9.0'])
          );
          expect(args).not.toContain('8.0.1xx');
        }
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining(
            "SDK feature band and will be ignored for 'dotnet-runtime: latest'"
          )
        );
      }
    );
  }
);
