import type { FileFilter, PlatformFilesystem } from '@/platform/types';

export const webFilesystem: PlatformFilesystem = {
  async saveFile(filename: string, blob: Blob, _filters?: FileFilter[]) {
    // Browser: trigger download
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Defer revocation so Safari/WebKit finishes initiating the download first.
    setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    return { status: 'download_started' };
  },

  async openPath(_path: string) {
    // No filesystem access in browser
  },

  async pickDirectory(_title: string) {
    return null;
  },
};
