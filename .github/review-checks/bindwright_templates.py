"""Pre-screen check: which changed files are Bindwright's template text, unedited.

It renders the Bindwright setup the way the recorded release writes it and
lists each changed file whose text equals that render, so the review can send
a finding in such a file upstream instead of blocking this repo on text it does
not own. The render uses:

- the Bindwright release the head's `.bindwright/pristine.json` records, which
  every setup and update writes, downloaded only from starfoxcom/bindwright's
  release page, so the record can name a published release and nothing else,
  and never one older than the base's record;
- the wheel's SHA-256 from the base's `.bindwright/helper.json`, the pin the
  review jobs install the helper from, so a PR cannot pick the hash. A wheel
  that does not match is never opened, so a swapped release file cannot run
  here. A PR that moves the release (an update) lists nothing, since the base
  pins no hash for it yet; the PRs after it merges list as usual;
- the base's `.bindwright/project.json` answers and `.bindwright/pristine.json`
  year, so a PR cannot steer what the render fills in.

The base is the first parent of the merge commit the review checks out. The
check never fails the pre-screen: when anything is missing or refused it says
why and lists nothing, and every file keeps its normal review.

Run by the gate's Project pre-screen job from the base branch:
    bindwright_templates.py FILES DIFF
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import urllib.request
import zipfile

ANSWERS = ".bindwright/project.json"
PRISTINE = ".bindwright/pristine.json"
PIN = ".bindwright/helper.json"
STAGING = ".bindwright/incoming/"
RELEASES = "https://github.com/starfoxcom/bindwright/releases/download"
# Together well under the pre-screen job's 300 s limit, which would fail the job.
DOWNLOAD_SECONDS = 60
RENDER_SECONDS = 120
HEADING = "Bindwright template text, unedited"


class Skip(Exception):
    """A reason the check lists nothing."""


def git_show(rev, path):
    """The bytes of `path` at `rev`, or None when it has no such file."""
    r = subprocess.run(["git", "show", "%s:./%s" % (rev, path)], capture_output=True)
    return r.stdout if r.returncode == 0 else None


def base_commit():
    """The base tip: the first parent of the PR's merge commit."""
    r = subprocess.run(["git", "rev-list", "--parents", "-n", "1", "HEAD"], capture_output=True, text=True)
    parents = r.stdout.split()[1:] if r.returncode == 0 else []
    if len(parents) != 2:
        raise Skip("HEAD is not a pull request's merge commit, so there is no base to read")
    return parents[0]


def read_json(rev, path):
    """The JSON object in `path` at `rev`."""
    side = "the head" if rev == "HEAD" else "the base"
    data = git_show(rev, path)
    if data is None:
        raise Skip("%s has no %s" % (side, path))
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Skip("%s's %s is not valid JSON" % (side, path))
    if not isinstance(value, dict):
        raise Skip("%s's %s is not an object" % (side, path))
    return value


def recorded_release(record, side):
    """The release a pristine record names, as `x.y.z` and as a tuple of numbers."""
    text = record.get("version")
    match = re.fullmatch(r"v?([0-9]+)\.([0-9]+)\.([0-9]+)", text) if isinstance(text, str) else None
    if not match:
        raise Skip("%s's %s records no Bindwright release" % (side, PRISTINE))
    return ".".join(match.groups()), tuple(int(part) for part in match.groups())


def pinned_hash(base, release):
    """The wheel's SHA-256 the base's pin records for `release`; a PR cannot change it."""
    pin = read_json(base, PIN)
    python = pin.get("python")
    digest = python.get("sha256") if isinstance(python, dict) else None
    if pin.get("version") != release or not isinstance(digest, str) \
            or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise Skip("the base's %s records no wheel hash for Bindwright %s" % (PIN, release))
    return digest


def verified(data, digest):
    """The wheel's bytes, once their SHA-256 matches the pin."""
    if hashlib.sha256(data).hexdigest() != digest:
        raise Skip("the downloaded wheel does not match the hash in %s" % PIN)
    return data


def download(url):
    with urllib.request.urlopen(url, timeout=DOWNLOAD_SECONDS) as response:
        return response.read()


def fetch(release):
    """The release's wheel within DOWNLOAD_SECONDS in all, so the job's time limit is never hit."""
    url = "%s/v%s/bindwright-%s-py3-none-any.whl" % (RELEASES, release, release)
    result = {}

    def worker():
        try:
            result["data"] = download(url)
        except Exception as e:
            result["error"] = e

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    thread.join(DOWNLOAD_SECONDS)
    if thread.is_alive():
        raise Skip("the wheel download took over %d s" % DOWNLOAD_SECONDS)
    if "error" in result:
        raise Skip("the wheel download failed: %s" % result["error"])
    return result["data"]


def unpack(data, folder):
    """Unpacks the wheel; returns the engine's bind.py."""
    path = os.path.join(folder, "helper.whl")
    with open(path, "wb") as fh:
        fh.write(data)
    target = os.path.join(folder, "helper")
    with zipfile.ZipFile(path) as wheel:
        for name in wheel.namelist():
            if name.startswith(("/", "\\")) or ".." in re.split(r"[\\/]", name):
                raise Skip("the wheel holds a path outside its folder")
        wheel.extractall(target)
    engine = os.path.join(target, "bindwright", "engine", "bind.py")
    if not os.path.isfile(engine):
        raise Skip("the wheel holds no engine")
    return engine


def render(engine, answers, year):
    """The bind's files, as the engine writes them for these answers and year."""
    command = [sys.executable, "-E", "-s", engine]
    if isinstance(year, int):
        command += ["--year", str(year)]
    try:
        # Run from the unpacked wheel, so nothing in the PR's checkout is in the engine's working folder.
        r = subprocess.run(command, input=json.dumps(answers).encode("utf-8"), capture_output=True,
                           timeout=RENDER_SECONDS, cwd=os.path.dirname(engine))
        out = json.loads(r.stdout.decode("utf-8"))
    except (subprocess.TimeoutExpired, UnicodeDecodeError, ValueError):
        raise Skip("the recorded engine gave no render")
    if not isinstance(out, dict) or "files" not in out:
        raise Skip("the recorded engine refused the base's answers: %s" % (out or {}).get("error", "no reason"))
    files = {}
    for path, text in out["files"]:
        if path.startswith(STAGING):
            path = path[len(STAGING):]
        if not path.startswith(".bindwright/"):
            files[path] = text
    return files


def text_at(rev, path):
    data = git_show(rev, path)
    if data is None:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def matches(text, render, base_text):
    """Whether the head's text is the render, in the render's line endings or in the CRLF ones the
    base copy already used on every line, so a PR that only adds carriage returns is never listed."""
    if text == render:
        return True
    crlf = render.replace("\r\n", "\n").replace("\n", "\r\n")
    base_is_crlf = base_text is not None and "\r\n" in base_text and "\n" not in base_text.replace("\r\n", "")
    return base_is_crlf and text == crlf


def unedited(changed, rendered, base):
    """The changed files whose head text equals the render."""
    found = []
    for path in changed:
        if path not in rendered:
            continue
        text = text_at("HEAD", path)
        if text is not None and matches(text, rendered[path], text_at(base, path)):
            found.append(path)
    return found


def changed_files(path):
    with open(path, encoding="utf-8") as fh:
        return [line for line in fh.read().splitlines() if line]


def run(files_path):
    base = base_commit()
    release, version = recorded_release(read_json("HEAD", PRISTINE), "the head")
    record = read_json(base, PRISTINE)
    floor, floor_version = recorded_release(record, "the base")
    if version < floor_version:
        raise Skip("the head records Bindwright %s, older than the base's %s" % (release, floor))
    answers = read_json(base, ANSWERS)
    digest = pinned_hash(base, release)
    with tempfile.TemporaryDirectory() as folder:
        wheel = verified(fetch(release), digest)
        rendered = render(unpack(wheel, folder), answers, record.get("year"))
    return release, unedited(changed_files(files_path), rendered, base)


def main(argv):
    try:
        release, found = run(argv[0])
    except Exception as e:
        reason = e if isinstance(e, Skip) else "the check failed (%s: %s)" % (type(e).__name__, e)
        print("%s: none listed, since %s. Every changed file gets the normal review." % (HEADING, reason))
        return 0
    if not found:
        print("%s: no changed file equals the render of Bindwright %s." % (HEADING, release))
        return 0
    print("%s (each equals the render of Bindwright %s from the base's answers):" % (HEADING, release))
    print("\n".join("- " + path for path in found))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
