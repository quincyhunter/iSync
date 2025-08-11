// Minimal API client for iSync mobile uploader
// Aligns with backend POST /upload contract

export type PresignedUrlResponse = {
  uploadId: string;
  presignedUrl: string;
  expiresIn: number;
  maxFileSize: number;
  requiredHeaders: Record<string, string>;
};

// Temporary configuration. Replace with env-driven config later.
export const API_BASE = 'https://h750ty0lbj.execute-api.us-east-1.amazonaws.com/prod';

export type MetadataPayload = {
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  trackNumber?: number;
};

export type Ec2Status = {
  state?: string;
  desiredCapacity?: number;
  runningInstances?: number;
  queueDepth?: number;
  message?: string;
};

export async function initiateUpload(params: {
  fileName: string;
  fileSize: number;
  contentType: string;
  userId: string;
  metadata?: MetadataPayload;
}): Promise<PresignedUrlResponse> {
  const response = await fetch(`${API_BASE}/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Upload init failed (${response.status}): ${text}`);
  }

  return (await response.json()) as PresignedUrlResponse;
}

export async function getEc2Status(): Promise<Ec2Status> {
  try {
    const res = await fetch(`${API_BASE}/ec2/status`);
    if (!res.ok) {
      return { message: `Status unavailable (${res.status})` };
    }
    return (await res.json()) as Ec2Status;
  } catch (e: any) {
    return { message: e?.message || 'Status unavailable' };
  }
}

export async function startEc2(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/ec2/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return res.ok;
}

export async function stopEc2(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/ec2/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return res.ok;
}


