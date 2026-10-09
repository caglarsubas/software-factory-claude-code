# Rule tests for default.yaml (`opengrep test`).
import ssl
import tempfile

import jwt
import requests

# ruleid: py-tls-verification-disabled
requests.get("https://example.test", verify=False)
# ok: py-tls-verification-disabled
requests.get("https://example.test", verify=True)
# ruleid: py-tls-verification-disabled
ctx = ssl._create_unverified_context()
# ruleid: py-tls-verification-disabled
ctx.check_hostname = False
# ruleid: py-tls-verification-disabled
ctx.verify_mode = ssl.CERT_NONE

# ruleid: py-jwt-signature-not-verified
jwt.decode(token, options={"verify_signature": False})
# ok: py-jwt-signature-not-verified
jwt.decode(token, key, algorithms=["RS256"])

# ruleid: py-insecure-tempfile
path = tempfile.mktemp()
# ok: py-insecure-tempfile
fd, path = tempfile.mkstemp()

# ruleid: py-debug-server
app.run(host="0.0.0.0", debug=True)
# ok: py-debug-server
app.run(host="127.0.0.1")
