import type { NextApiRequest, NextApiResponse } from 'next';
import * as crypto from 'crypto';

export const config = {
  api: {
    bodyParser: false,
  },
};

// リクエストボディを読み取るヘルパー関数
function getRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk.toString();
    });
    req.on('end', () => {
      resolve(data);
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // POSTメソッドのみ受け付ける
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 生のリクエストボディを読み取る
    const rawBody = await getRawBody(req);
    
    if (!rawBody) {
      return res.status(400).json({ error: 'Empty request body' });
    }

    // JSONとしてパース
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (parseError) {
      console.error('Failed to parse JSON:', parseError);
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    // Slack URL verification (challenge) - 署名検証をスキップ
    if (body.type === 'url_verification') {
      if (!body.challenge) {
        return res.status(400).json({ error: 'Missing challenge parameter' });
      }
      // challengeの値をそのままプレーンテキストで返す（Slackの仕様）
      return res.status(200).send(body.challenge);
    }

    // 通常のイベントの場合、署名検証を実行
    const timestamp = req.headers['x-slack-request-timestamp'] as string;
    const signature = req.headers['x-slack-signature'] as string;

    if (!timestamp || !signature) {
      return res.status(401).json({ error: 'Missing required headers' });
    }

    // 署名検証用のbasestringは生のボディを使用
    const basestring = `v0:${timestamp}:${rawBody}`;
    const signingSecret = process.env.SLACK_SIGNING_SECRET;

    if (!signingSecret) {
      console.error('SLACK_SIGNING_SECRET is not set');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const mySignature = `v0=` + crypto.createHmac('sha256', signingSecret)
      .update(basestring, 'utf8')
      .digest('hex');

    if (mySignature !== signature) {
      console.error('Signature verification failed', {
        expected: signature,
        calculated: mySignature,
      });
      return res.status(401).json({ error: 'Verification failed' });
    }

    // Event handling
    const event = body.event;

    // Bot がメンションされた場合の処理
    if (event && event.type === 'app_mention') {
      // Dify API呼び出しなどをここで実行する
      console.log('App mention received:', event);
    }

    res.status(200).end();
  } catch (error) {
    console.error('Error processing Slack event:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
