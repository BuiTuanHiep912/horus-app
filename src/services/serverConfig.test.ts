jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import { apiUrl, normalizeBaseUrl, wsUrl } from './serverConfig';

test('bare host defaults to https, trailing slash is dropped, scheme is kept', () => {
  expect(normalizeBaseUrl(' api.example.com/ ')).toBe('https://api.example.com');
  expect(normalizeBaseUrl('http://10.0.0.5:3000')).toBe('http://10.0.0.5:3000');
  expect(normalizeBaseUrl('')).toBe('');
});

test('ws url follows the http scheme and api url adds the prefix', () => {
  expect(wsUrl({ baseUrl: 'https://api.example.com' })).toBe('wss://api.example.com');
  expect(wsUrl({ baseUrl: 'http://10.0.0.5:3000' })).toBe('ws://10.0.0.5:3000');
  expect(apiUrl({ baseUrl: 'https://api.example.com' })).toBe(
    'https://api.example.com/it4788/api/v1',
  );
});
