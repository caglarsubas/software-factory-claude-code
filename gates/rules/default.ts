// Rule tests for default.yaml (`opengrep test`). Not compiled or linted.
import https from "node:https";
import jwt from "jsonwebtoken";

// ruleid: js-tls-verification-disabled
const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
// ok: js-tls-verification-disabled
const strict = new https.Agent({ rejectUnauthorized: true });
// ruleid: js-tls-verification-disabled
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// ruleid: js-jwt-none-algorithm
jwt.verify(token, key, { algorithms: ["HS256", "none"] });
// ok: js-jwt-none-algorithm
jwt.verify(token, key, { algorithms: ["RS256"] });
