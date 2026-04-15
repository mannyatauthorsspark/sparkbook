import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
})

export async function uploadToR2(
  bucket: string,
  key: string,
  body: Buffer | string,
  contentType = 'text/plain'
) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  )
  return key
}

export async function getFromR2(bucket: string, key: string): Promise<string> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  )
  return response.Body!.transformToString()
}

export async function presignR2(
  bucket: string,
  key: string,
  expiresIn = 86400 // 24 hours
): Promise<string> {
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn }
  )
}

export async function deleteFromR2(bucket: string, key: string) {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
}

export const BUCKETS = {
  transcripts: process.env.R2_BUCKET_TRANSCRIPTS!,
  exports: process.env.R2_BUCKET_EXPORTS!,
}
