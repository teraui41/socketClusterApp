const http = require("http");
const eetase = require("eetase");
const socketClusterServer = require("socketcluster-server");
const express = require("express");
const serveStatic = require("serve-static");
const path = require("path");
const morgan = require("morgan");
const uuid = require("uuid");
const sccBrokerClient = require("scc-broker-client");

const ENVIRONMENT = process.env.ENV || "dev";
const SOCKETCLUSTER_PORT = process.env.SOCKETCLUSTER_PORT || 8000;
const SOCKETCLUSTER_WS_ENGINE = process.env.SOCKETCLUSTER_WS_ENGINE || "ws";
const SOCKETCLUSTER_SOCKET_CHANNEL_LIMIT =
  Number(process.env.SOCKETCLUSTER_SOCKET_CHANNEL_LIMIT) || 1000;
const SOCKETCLUSTER_LOG_LEVEL = process.env.SOCKETCLUSTER_LOG_LEVEL || 2;

const SCC_INSTANCE_ID = uuid.v4();
const SCC_STATE_SERVER_HOST = process.env.SCC_STATE_SERVER_HOST || null;
const SCC_STATE_SERVER_PORT = process.env.SCC_STATE_SERVER_PORT || null;
const SCC_MAPPING_ENGINE = process.env.SCC_MAPPING_ENGINE || null;
const SCC_CLIENT_POOL_SIZE = process.env.SCC_CLIENT_POOL_SIZE || null;
const SCC_AUTH_KEY = process.env.SCC_AUTH_KEY || null;
const SCC_INSTANCE_IP = process.env.SCC_INSTANCE_IP || null;
const SCC_INSTANCE_IP_FAMILY = process.env.SCC_INSTANCE_IP_FAMILY || null;
const SCC_STATE_SERVER_CONNECT_TIMEOUT =
  Number(process.env.SCC_STATE_SERVER_CONNECT_TIMEOUT) || null;
const SCC_STATE_SERVER_ACK_TIMEOUT =
  Number(process.env.SCC_STATE_SERVER_ACK_TIMEOUT) || null;
const SCC_STATE_SERVER_RECONNECT_RANDOMNESS =
  Number(process.env.SCC_STATE_SERVER_RECONNECT_RANDOMNESS) || null;
const SCC_PUB_SUB_BATCH_DURATION =
  Number(process.env.SCC_PUB_SUB_BATCH_DURATION) || null;
const SCC_BROKER_RETRY_DELAY =
  Number(process.env.SCC_BROKER_RETRY_DELAY) || null;

let agOptions = {};

if (process.env.SOCKETCLUSTER_OPTIONS) {
  let envOptions = JSON.parse(process.env.SOCKETCLUSTER_OPTIONS);
  Object.assign(agOptions, envOptions);
}

let httpServer = eetase(http.createServer());
// 建立 socket cluster server.
let agServer = socketClusterServer.attach(httpServer, agOptions);

let expressApp = express();
if (ENVIRONMENT === "dev") {
  // Log every HTTP request. See https://github.com/expressjs/morgan for other
  // available formats.
  expressApp.use(morgan("dev"));
}
expressApp.use(serveStatic(path.resolve(__dirname, "public")));

// Add GET /health-check express route
expressApp.get("/health-check", (req, res) => {
  res.status(200).send("OK");
});

const creatJWTToken = async () => {
  let myTokenData = {
    username: 'bob',
    language: 'English',
    company: 'Google',
    groups: ['engineering', 'science', 'mathematics']
  };
  try {
    return await agServer.auth.signToken(myTokenData, agServer.signatureKey);
  } catch (error) {
    throw error;
  }
}

// HTTP request handling loop.
// 用來處理進來的 request
(async () => {
  for await (let requestData of httpServer.listener("request")) {
    expressApp.apply(null, requestData);
  }
})();

// SocketCluster/WebSocket connection handling loop.
// 用來處理進來的 connection
(async () => {
  for await (let { socket } of agServer.listener("connection")) {
    // 處理 socket 連線事件
    console.log("socket 連線成功");

    (async () => {
      // 處理前端傳來的 transmitted 事件。Set up a loop to handle remote transmitted events.
      for await (let data of socket.receiver("customRemoteEvent")) {
        console.log("customRemoteEvent: ", data);
      }
    })();

    (async () => {
      // 處理遠端程序呼叫並給予回傳值。Set up a loop to handle and respond to RPCs.
      for await (let request of socket.procedure("customProc")) {
        if (request.data && request.data.bad) {
          let badCustomError = new Error(
            "Server failed to execute the procedure"
          );
          badCustomError.name = "BadCustomError";
          request.error(badCustomError);
          continue;
        }
        request.end("Success");
      }
    })();

    (async () => {
      try {
        // Publish data; wait for an acknowledgement from the back end broker (if it exists).
        await agServer.exchange.invokePublish(
          "channel_A",
          "從 Server 廣播出來的信息（invokePublish）"
        );
      } catch (error) {
        // ... Handle potential error if broker does not acknowledge before timeout.
      }
    })();

    agServer.exchange.transmitPublish(
      "channel_A",
      "從 Server 廣播出來的信息（transmitPublish）"
    );

    const doSomethingWhichTakesAFewSeconds = async () => {
      return new Promise((res, rej) => {
        setTimeout(() => res('１秒後非同步回傳結果'), 1000);
      });
    };

    (async () => {
      // This will not work because the iterator is not yet created at this point.
      let fooStream = socket.receiver("channel_B");

      // If any messages arrive during this time, they will be ignored!
      const result = await doSomethingWhichTakesAFewSeconds();
      console.log("沒有使用 Consumer -> result", result)

      // The iterator gets created (and starts buffering) here!
      // 沒如果沒有使用 Consumer，當上面的非同步還在處理，信息會無法接收。
      for await (let data of fooStream) {
        console.log("沒有使用 Consumer -> data", data);
        // ...
      }
    })();

    (async () => {
      // This will not work because the iterator is not yet created at this point.
      let fooStream = socket.receiver("channel_B").createConsumer();

      // If any messages arrive during this time, they will be ignored!
      const result = await doSomethingWhichTakesAFewSeconds();
      console.log("使用 Consumer -> result", result)

      // The iterator gets created (and starts buffering) here!
      for await (let data of fooStream) {
        console.log("使用 Consumer -> data", data);
        // ...
      }
    })();

    (async () => {
      let fooStream = socket.procedure("login").createConsumer();
      for await (let request of fooStream) {
        socket.setAuthToken({username: request.data.username});
        request.end();
      }
    })();
  }
})();

// 啟用 server 開始監聽
httpServer.listen(SOCKETCLUSTER_PORT);

if (SOCKETCLUSTER_LOG_LEVEL >= 1) {
  (async () => {
    for await (let { error } of agServer.listener("error")) {
      console.error(error);
    }
  })();
}

if (SOCKETCLUSTER_LOG_LEVEL >= 2) {
  console.log(
    `   ${colorText("[Active]", 32)} SocketCluster worker with PID ${
      process.pid
    } is listening on port ${SOCKETCLUSTER_PORT}`
  );

  (async () => {
    for await (let { warning } of agServer.listener("warning")) {
      console.warn(warning);
    }
  })();
}

function colorText(message, color) {
  if (color) {
    return `\x1b[${color}m${message}\x1b[0m`;
  }
  return message;
}

if (SCC_STATE_SERVER_HOST) {
  // Setup broker client to connect to SCC.
  let sccClient = sccBrokerClient.attach(agServer.brokerEngine, {
    instanceId: SCC_INSTANCE_ID,
    instancePort: SOCKETCLUSTER_PORT,
    instanceIp: SCC_INSTANCE_IP,
    instanceIpFamily: SCC_INSTANCE_IP_FAMILY,
    pubSubBatchDuration: SCC_PUB_SUB_BATCH_DURATION,
    stateServerHost: SCC_STATE_SERVER_HOST,
    stateServerPort: SCC_STATE_SERVER_PORT,
    mappingEngine: SCC_MAPPING_ENGINE,
    clientPoolSize: SCC_CLIENT_POOL_SIZE,
    authKey: SCC_AUTH_KEY,
    stateServerConnectTimeout: SCC_STATE_SERVER_CONNECT_TIMEOUT,
    stateServerAckTimeout: SCC_STATE_SERVER_ACK_TIMEOUT,
    stateServerReconnectRandomness: SCC_STATE_SERVER_RECONNECT_RANDOMNESS,
    brokerRetryDelay: SCC_BROKER_RETRY_DELAY,
  });

  if (SOCKETCLUSTER_LOG_LEVEL >= 1) {
    (async () => {
      for await (let { error } of sccClient.listener("error")) {
        error.name = "SCCError";
        console.error(error);
      }
    })();
  }
}
