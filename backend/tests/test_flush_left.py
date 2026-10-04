from app.schemas import flush_left


def test_strips_screenplay_indentation():
    raw = "MARA drifts.\r\n\r\n                    NARRATOR (V.O.)\r\n\t\tTen years ago.  "
    assert flush_left(raw) == "MARA drifts.\n\nNARRATOR (V.O.)\nTen years ago."


def test_patch_stores_script_flush_left(client, project):
    scene = client.post(f"/api/projects/{project['id']}/scenes", json={"heading": "EXT. REEF - DAY"}).json()
    body = {"script_text": "She waits.\n\n          NARRATOR\n     It was alive."}
    saved = client.patch(f"/api/scenes/{scene['id']}", json=body).json()
    assert saved["script_text"] == "She waits.\n\nNARRATOR\nIt was alive."
