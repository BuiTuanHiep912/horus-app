jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 1234 })),
  FileSystemUploadType: { BINARY_CONTENT: 0 },
  createUploadTask: jest.fn((_url, _uri, _opts, onProgress) => ({
    uploadAsync: async () => {
      onProgress?.({ totalBytesSent: 1234, totalBytesExpectedToSend: 1234 });
      return { status: 200, body: '' };
    },
  })),
}));

import * as FileSystem from 'expo-file-system/legacy';
import { uploadService } from './upload';

const meta = { localVideoUid: 'uid-1', deviceId: 'dev-1', sessionId: 's-1' };
const envelope = (code: number, data: unknown = null) => ({
  status: 200,
  json: async () => ({ code, message: '', data }),
});
const initOk = envelope(1000, {
  upload_id: 'up-1',
  upload_url: 'https://s3.example.com/put?sig=x',
  expires_at: null,
  already_uploaded: 0,
  video_id: null,
});
const completeOk = envelope(1000, { video_id: 'vid-1' });

/** Trả lần lượt các response cho từng endpoint API (theo hậu tố URL). */
function mockApi(responses: { init: object[]; complete?: object[] }) {
  const fetchMock = jest.fn(async (url: string) => {
    const queue = url.endsWith('/complete') ? responses.complete! : responses.init;
    return queue.shift();
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const createUploadTask = FileSystem.createUploadTask as jest.Mock;

beforeEach(() => createUploadTask.mockClear());

test('init -> PUT whole file without auth -> complete', async () => {
  mockApi({ init: [initOk], complete: [completeOk] });
  const progress: number[] = [];

  const result = await uploadService.uploadVideo('file:///clip.mp4', meta, p => progress.push(p));

  expect(result).toEqual({ videoId: 'vid-1', alreadyUploaded: false });
  expect(createUploadTask).toHaveBeenCalledTimes(1);
  const [url, uri, opts] = createUploadTask.mock.calls[0];
  expect(url).toBe('https://s3.example.com/put?sig=x');
  expect(uri).toBe('file:///clip.mp4');
  expect(opts).toEqual({
    httpMethod: 'PUT',
    uploadType: 0,
    headers: { 'Content-Type': 'video/mp4' },
  });
  expect(progress[progress.length - 1]).toBe(100);
});

test('complete 1011 -> PUT again then complete', async () => {
  mockApi({ init: [initOk], complete: [envelope(1011), completeOk] });

  const result = await uploadService.uploadVideo('file:///clip.mp4', meta);

  expect(result.videoId).toBe('vid-1');
  expect(createUploadTask).toHaveBeenCalledTimes(2);
});

test('already_uploaded skips PUT and complete', async () => {
  const fetchMock = mockApi({
    init: [
      envelope(1000, {
        upload_id: null,
        upload_url: null,
        expires_at: null,
        already_uploaded: 1,
        video_id: 'vid-old',
      }),
    ],
  });

  const result = await uploadService.uploadVideo('file:///clip.mp4', meta);

  expect(result).toEqual({ videoId: 'vid-old', alreadyUploaded: true });
  expect(createUploadTask).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
