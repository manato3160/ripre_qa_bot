import type { NextApiRequest, NextApiResponse } from 'next';
import * as crypto from 'crypto';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Slack URL verification (challenge)
  if (req.body.type === 'url_verification') {
    return res.status(200).send(req.body.challenge);
  }

  // Slack signature verification
  const timestamp = req.headers['x-slack-request-timestamp'] as string;
  const signature = req.headers['x-slack-signature'] as string;

  const basestring = `v0:${timestamp}:${JSON.stringify(req.body)}`;
  const mySignature = `v0=` + crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET!)
    .update(basestring, 'utf8')
    .digest('hex');

  if (mySignature !== signature) {
    return res.status(400).send("Verification failed");
  }

  // Event handling
  const event = req.body.event;

  // Bot がメンションされた場合の処理
  if (event.type === 'app_mention') {
    // Dify API呼び出しなどをここで実行する
  }

  res.status(200).end();
}
