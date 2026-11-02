/**
 * Uploads API — init (nhận presigned PUT URL) -> PUT file thẳng lên S3 -> complete
 * POST /videos/uploads | POST /videos/uploads/:id/complete | DELETE /videos/uploads/:id
 */

import { apiRequest } from './client';
import { CompleteUploadData, InitUploadData, InitUploadPayload } from './types';

export async function initUpload(payload: InitUploadPayload): Promise<InitUploadData> {
  return apiRequest('/videos/uploads', { method: 'POST', body: payload });
}

export async function completeUpload(uploadId: string): Promise<CompleteUploadData> {
  return apiRequest(`/videos/uploads/${uploadId}/complete`, { method: 'POST' });
}

export async function abortUpload(uploadId: string): Promise<unknown> {
  return apiRequest(`/videos/uploads/${uploadId}`, { method: 'DELETE' });
}
