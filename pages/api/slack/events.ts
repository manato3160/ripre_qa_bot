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

  // 環境変数のチェック（デバッグ用に詳細なエラーメッセージを出力）
  const missingVars: string[] = [];
  if (!difyApiUrl) missingVars.push('DIFY_API_URL');
  if (!difyApiKey) missingVars.push('DIFY_API_KEY');
  if (!workflowId) missingVars.push('DIFY_WORKFLOW_ID');

  if (missingVars.length > 0) {
    const errorMsg = `Dify configuration is missing. Missing environment variables: ${missingVars.join(', ')}`;
    console.error(errorMsg);
    console.error('Environment variables check:', {
      DIFY_API_URL: difyApiUrl ? `${difyApiUrl.substring(0, 20)}...` : 'NOT SET',
      DIFY_API_KEY: difyApiKey ? `${difyApiKey.substring(0, 10)}...` : 'NOT SET',
      DIFY_WORKFLOW_ID: workflowId ? `${workflowId.substring(0, 10)}...` : 'NOT SET',
    });
    throw new Error(errorMsg);
  }

  // Dify APIのエンドポイント構築
  // DIFY_API_URLに既にバージョンが含まれている場合（例: https://dify.aibase.buzz/v1）
  // と含まれていない場合（例: https://api.dify.ai）の両方に対応
  // ここまで来た時点で、difyApiUrlは必ず設定されている（上でチェック済み）
  let baseUrl = difyApiUrl!.trim();
  
  // 末尾のスラッシュを除去
  if (baseUrl.endsWith('/')) {
    baseUrl = baseUrl.slice(0, -1);
  }
  
  // DIFY_API_URLに既にバージョンが含まれているかチェック
  const hasVersionInUrl = /\/v\d+$/.test(baseUrl);
  
  let endpoint: string;
  if (hasVersionInUrl) {
    // 既にバージョンが含まれている場合（例: https://dify.aibase.buzz/v1）
    endpoint = `${baseUrl}/workflows/${workflowId}/run`;
  } else {
    // バージョンが含まれていない場合
    const apiVersion = process.env.DIFY_API_VERSION || 'v1';
    endpoint = `${baseUrl}/${apiVersion}/workflows/${workflowId}/run`;
  }

  console.log('Calling Dify API:', {
    endpoint,
    workflowId,
    userInputLength: userInput.length,
  });

  const requestBody = {
    inputs: {
      query: userInput,
    },
    response_mode: 'blocking',
    user: 'slack-bot',
  };

  console.log('Sending request to Dify API:', {
    endpoint,
    requestBody: JSON.stringify(requestBody),
    timestamp: new Date().toISOString(),
  });

  let response: Response;
  const startTime = Date.now();
  try {
    // タイムアウト設定（30秒）
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.error('Dify API request timeout - aborting after 30s');
      controller.abort();
    }, 30000);

    console.log('Starting fetch request to Dify API...');
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${difyApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const elapsedTime = Date.now() - startTime;
    console.log(`Fetch completed in ${elapsedTime}ms`);
  } catch (fetchError) {
    const elapsedTime = Date.now() - startTime;
    console.error('Dify API fetch error:', {
      error: fetchError,
      errorName: fetchError instanceof Error ? fetchError.name : 'Unknown',
      errorMessage: fetchError instanceof Error ? fetchError.message : 'Unknown error',
      elapsedTime: `${elapsedTime}ms`,
      endpoint,
    });
    
    if (fetchError instanceof Error && fetchError.name === 'AbortError') {
      throw new Error(`Dify API request timeout after ${elapsedTime}ms (30s limit)`);
    }
    throw new Error(`Failed to call Dify API: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`);
  }

  console.log('Dify API response received:', {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Dify API error:', {
      status: response.status,
      statusText: response.statusText,
      endpoint,
      errorText,
    });
    throw new Error(`Dify API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  console.log('Dify API response data:', {
    hasAnswer: !!data.answer,
    hasData: !!data.data,
    hasOutput: !!data.output,
    dataKeys: Object.keys(data),
    responsePreview: JSON.stringify(data).substring(0, 200),
  });
  
  // Difyのレスポンス構造に応じて調整
  // 一般的なレスポンス構造: { answer: "...", data: {...} }
  if (data.answer) {
    console.log('Using data.answer');
    return data.answer;
  }
  if (data.data) {
    // ワークフローの出力から回答を取得
    if (data.data.outputs) {
      const outputs = data.data.outputs;
      console.log('Using data.data.outputs:', Object.keys(outputs));
      // ワークフローの出力ノード名に応じて調整
      // 一般的な出力ノード名: answer, text, result, output など
      const answer = outputs.answer || outputs.text || outputs.result || outputs.output;
      if (answer) {
        return typeof answer === 'string' ? answer : JSON.stringify(answer);
      }
      // 出力がオブジェクトの場合、最初の文字列値を探す
      for (const key in outputs) {
        if (typeof outputs[key] === 'string' && outputs[key].trim()) {
          console.log(`Using outputs.${key}`);
          return outputs[key];
        }
      }
      console.warn('No string value found in outputs:', outputs);
      return JSON.stringify(outputs);
    }
    // data.dataが直接文字列の場合
    if (typeof data.data === 'string') {
      console.log('Using data.data as string');
      return data.data;
    }
    console.warn('Unexpected data.data structure:', data.data);
  }
  if (data.output) {
    console.log('Using data.output');
    return typeof data.output === 'string' ? data.output : JSON.stringify(data.output);
  }
  
  // フォールバック: レスポンス全体を文字列化
  console.warn('Unexpected Dify API response structure:', JSON.stringify(data));
  return JSON.stringify(data, null, 2);
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
    
    console.log('Received Slack event:', {
      type: body.type,
      eventType: event?.type,
      eventSubtype: event?.subtype,
      hasEvent: !!event,
    });

    // Bot がメンションされた場合の処理
    if (event && event.type === 'app_mention') {
      console.log('App mention event detected:', {
        channel: event.channel,
        user: event.user,
        text: event.text,
        ts: event.ts,
      });
      // Bot自身のメッセージは無視
      if (event.subtype === 'bot_message') {
        return res.status(200).end();
      }

      // SlackのイベントAPIは3秒以内に応答する必要があるため、
      // 先に200を返してからバックグラウンドで処理を実行
      res.status(200).end();
      
      console.log('Sent 200 response, starting background processing');

      // バックグラウンドでDify APIを呼び出し、結果をSlackに投稿
      (async () => {
        try {
          console.log('Background processing started');
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
          console.log('About to call Dify API with message:', messageText.substring(0, 100));
          const difyResponse = await callDifyWorkflow(messageText);
          console.log('Dify API call completed, response length:', difyResponse.length);

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
            let errorMessage = 'エラーが発生しました。';
            
            if (error instanceof Error) {
              // 環境変数が不足している場合のメッセージ
              if (error.message.includes('Dify configuration is missing')) {
                errorMessage = `❌ Difyの設定が不足しています。\n\n` +
                  `Vercelの環境変数に以下が設定されているか確認してください：\n` +
                  `• DIFY_API_URL\n` +
                  `• DIFY_API_KEY\n` +
                  `• DIFY_WORKFLOW_ID\n\n` +
                  `詳細はVercelのログを確認してください。`;
              } else if (error.message.includes('Dify API error')) {
                errorMessage = `❌ Dify APIでエラーが発生しました。\n\n` +
                  `${error.message}\n\n` +
                  `Vercelのログで詳細を確認してください。`;
              } else {
                errorMessage = `❌ ${error.message}`;
              }
            } else {
              errorMessage += ' Unknown error';
            }
            
            await postSlackMessage(
              event.channel,
              errorMessage,
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
