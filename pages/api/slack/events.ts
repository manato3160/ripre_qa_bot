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

// Dify APIを呼び出す関数
async function callDifyWorkflow(userInput: string): Promise<string> {
  const difyApiUrl = process.env.DIFY_API_URL;
  const difyApiKey = process.env.DIFY_API_KEY;
  const workflowId = process.env.DIFY_WORKFLOW_ID;

  if (!difyApiUrl || !difyApiKey || !workflowId) {
    throw new Error('Dify configuration is missing');
  }

  // Dify APIのエンドポイント構築
  // DIFY_API_VERSIONが設定されている場合: /v1/workflows/{workflow_id}/run
  // 設定されていない場合（空文字列）: /workflows/{workflow_id}/run
  const apiVersion = process.env.DIFY_API_VERSION;
  let endpoint: string;
  
  if (apiVersion && apiVersion.trim() !== '') {
    // APIバージョンが指定されている場合
    endpoint = `${difyApiUrl}/${apiVersion}/workflows/${workflowId}/run`;
  } else {
    // APIバージョンが指定されていない場合（デフォルト）
    endpoint = `${difyApiUrl}/v1/workflows/${workflowId}/run`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${difyApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: {
        query: userInput,
      },
      response_mode: 'blocking',
      user: 'slack-bot',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Dify API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  // Difyのレスポンス構造に応じて調整
  // 一般的なレスポンス構造: { answer: "...", data: {...} }
  if (data.answer) {
    return data.answer;
  }
  if (data.data && data.data.outputs) {
    // ワークフローの出力から回答を取得
    const outputs = data.data.outputs;
    return outputs.answer || outputs.text || JSON.stringify(outputs);
  }
  if (data.output) {
    return data.output;
  }
  
  // フォールバック: レスポンス全体を文字列化
  console.warn('Unexpected Dify API response structure:', JSON.stringify(data));
  return JSON.stringify(data);
}

// Slackにメッセージを投稿する関数
async function postSlackMessage(
  channel: string,
  text: string,
  threadTs?: string
): Promise<void> {
  const slackBotToken = process.env.SLACK_BOT_TOKEN;

  if (!slackBotToken) {
    throw new Error('SLACK_BOT_TOKEN is not set');
  }

  const payload: {
    channel: string;
    text: string;
    thread_ts?: string;
  } = {
    channel,
    text,
  };

  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${slackBotToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Slack API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }
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
      // Bot自身のメッセージは無視
      if (event.subtype === 'bot_message') {
        return res.status(200).end();
      }

      // SlackのイベントAPIは3秒以内に応答する必要があるため、
      // 先に200を返してからバックグラウンドで処理を実行
      res.status(200).end();

      // バックグラウンドでDify APIを呼び出し、結果をSlackに投稿
      (async () => {
        try {
          // メンション部分を除去してメッセージテキストを取得
          const messageText = event.text
            .replace(/<@[A-Z0-9]+>/g, '') // メンションを除去
            .trim();

          if (!messageText) {
            await postSlackMessage(
              event.channel,
              'メッセージが空です。質問を入力してください。',
              event.ts
            );
            return;
          }

          console.log('Processing app mention:', {
            channel: event.channel,
            user: event.user,
            text: messageText,
          });

          // Dify APIを呼び出し
          const difyResponse = await callDifyWorkflow(messageText);

          // Slackに結果を投稿（スレッドで返信）
          await postSlackMessage(
            event.channel,
            difyResponse,
            event.ts
          );

          console.log('Successfully processed app mention');
        } catch (error) {
          console.error('Error processing app mention:', error);
          
          // エラーをSlackに通知
          try {
            await postSlackMessage(
              event.channel,
              `エラーが発生しました: ${error instanceof Error ? error.message : 'Unknown error'}`,
              event.ts
            );
          } catch (slackError) {
            console.error('Failed to post error message to Slack:', slackError);
          }
        }
      })();

      // バックグラウンド処理を開始したので、ここでreturn
      return;
    }

    // その他のイベントタイプは正常に受け取ったことを返す
    res.status(200).end();
  } catch (error) {
    console.error('Error processing Slack event:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
