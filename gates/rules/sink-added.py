# Rule tests for sink-added.yaml (`opengrep test`).
import os
import pickle
# ruleid: py-process-exec
import subprocess

import torch
import yaml

# ruleid: py-code-exec
eval(expr)
# ruleid: py-code-exec
exec(source)
# ok: py-code-exec
ast.literal_eval(expr)

# ruleid: py-process-exec
subprocess.run(cmd, shell=True)
# ruleid: py-process-exec
os.system("make")
# ruleid: py-os-exec-family
os.execvp("ls", ["ls"])
# ok: py-os-exec-family
os.path.join("a", "b")

# ruleid: py-unsafe-deserialization
pickle.loads(blob)
# ruleid: py-unsafe-deserialization
yaml.load(text)
# ruleid: py-unsafe-deserialization
yaml.load(text, Loader=yaml.Loader)
# ok: py-unsafe-deserialization
yaml.load(text, Loader=yaml.SafeLoader)
# ok: py-unsafe-deserialization
yaml.safe_load(text)
# ruleid: py-unsafe-deserialization
torch.load(path)
# ok: py-unsafe-deserialization
torch.load(path, weights_only=True)
