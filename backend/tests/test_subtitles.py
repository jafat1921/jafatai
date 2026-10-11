"""Burned subtitles (contract v24a): the font per script, the marks-aware wrap, the ASS file, both renderers
and the features that burn through them."""
import inspect
import shutil
from pathlib import Path

import pytest
from PIL import Image, ImageStat

from app import subtitles as st
from app.audio_analysis import stream_info
from app.config import get_settings
from app.db import SessionLocal
from app.dub import export as ex
from app.models import Job
from app.podcast import publish
from tests.test_audio_edit import ff, upload_video
from tests.test_podcast import _produced, get, ok
from tests.test_storyboard import _run_all
from tests.test_transcribe import talking_clip

URDU = "یہ ہمارا پہلا پروگرام ہے"
ARABIC = "مَرْحَبًا بِكُمْ فِي الْبَرْنَامَجِ"
PERSIAN = "این برنامه برای شما است"
HINDI = "यह हमारा पहला कार्यक्रम है"
# four letters and three marks: aerab-heavy Urdu, the case that used to wrap far too early
MUHABBAT = "مُحَبَّت"


def clip(path: Path, w: int = 320, h: int = 180, seconds: float = 2.0) -> Path:
    ff("-f", "lavfi", "-i", f"color=c=0x336699:s={w}x{h}:r=25:d={seconds}", "-f", "lavfi", "-i",
       f"sine=f=440:d={seconds}", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path))
    return path


def frame(video: Path, at: float, dest: Path) -> Image.Image:
    ff("-ss", f"{at:.2f}", "-i", str(video), "-frames:v", "1", str(dest))
    return Image.open(dest).convert("RGB")


def luma(img: Image.Image, box) -> float:
    return ImageStat.Stat(img.crop(box).convert("L")).mean[0]


# ---------------------------------------------------------------- fonts

@pytest.mark.parametrize("lang,text,family", [
    ("ur", URDU, st.NASTALIQ), ("ar", ARABIC, st.NASKH), ("fa", PERSIAN, st.NASKH), ("ps", "دا", st.NASKH),
    ("sd", "هي", st.NASKH), ("pnb", "ساڈا", st.NASKH), ("pa-arab", "ساڈا", st.NASKH),
    ("hi", HINDI, st.DEVANAGARI),
    ("en", "Hello there", st.LATIN), ("ur-latn", "Aap kaise hain", st.LATIN), ("es", "Hola", st.LATIN),
])
def test_font_for_each_language(lang, text, family):
    assert st.font_for(lang, text) == family


def test_font_from_the_letters_when_the_language_is_unknown():
    assert st.font_for(None, URDU) == st.NASTALIQ
    assert st.font_for("auto", ARABIC) == st.NASKH
    assert st.font_for(None, HINDI) == st.DEVANAGARI
    assert st.font_for(None, "Just English") == st.LATIN
    # an Urdu name in English subtitles still gets letters that join
    assert st.font_for("en", "عائشہ") == st.NASTALIQ


def test_font_files_come_from_the_fonts_dir(tmp_path, monkeypatch):
    noto = tmp_path / "noto"
    noto.mkdir()
    for name in ("NotoNastaliqUrdu-Regular.ttf", "NotoNastaliqUrdu-Bold.ttf", "NotoSansArabic-Regular.ttf"):
        (noto / name).write_bytes(b"")
    monkeypatch.setattr(get_settings(), "subtitle_fonts_dir", str(noto))
    monkeypatch.setattr(st, "_fc_list", lambda family: None)
    st._font_file.cache_clear()
    try:
        assert st.font_file(st.NASTALIQ) == noto / "NotoNastaliqUrdu-Regular.ttf"
        # NotoSansArabic is not Noto Sans
        assert st.font_file(st.LATIN) is None
        assert st.fonts_dir() == noto
    finally:
        st._font_file.cache_clear()


def test_missing_fonts_are_reported(tmp_path, monkeypatch):
    monkeypatch.setattr(st, "font_file", lambda family: None)
    monkeypatch.setattr(st, "_burn_ass", lambda src, dst, *a: shutil.copyfile(src, dst))
    monkeypatch.setattr(st, "renderer_for", lambda items: "ass")
    src = clip(tmp_path / "src.mp4")
    res = st.burn(src, tmp_path / "out.mp4", [(0, 1, URDU), (1, 2, "Hi")], width=320, height=180)
    assert res == {"renderer": "ass", "fonts_missing": [st.NASTALIQ, st.LATIN]}


# ---------------------------------------------------------------- wrapping

def _old_wrap(text, width=42):
    # the Latin-only wrap transcripts had before VP0, by plain character count
    text = " ".join(text.split())
    if len(text) <= width:
        return [text]
    words, best = text.split(" "), None
    for i in range(1, len(words)):
        a, b = " ".join(words[:i]), " ".join(words[i:])
        if len(a) <= width and len(b) <= width and (best is None or abs(len(a) - len(b)) < best[0]):
            best = (abs(len(a) - len(b)), [a, b])
    return best[1] if best else None


@pytest.mark.parametrize("text", [
    "short line", "This sentence is a little too long to sit on a single subtitle line",
    " ".join(["word"] * 40), "Exactly forty-two characters on this line.", "a " * 30,
])
def test_latin_wrap_is_unchanged(text):
    from app import transcripts as tr

    assert st.wrap(text) == _old_wrap(text) == tr.wrap(text)


def test_marks_do_not_count_towards_the_line_length():
    text = " ".join([MUHABBAT] * 12)
    assert st.visible_len(MUHABBAT) == 4
    assert st.width_for(None, text) == st.NASTALIQ_CHARS
    lines = st.wrap(text)
    assert lines is not None and len(lines) == 2
    assert all(st.visible_len(ln) <= st.NASTALIQ_CHARS for ln in lines)
    # counted with its marks, the same text would need a third line
    assert any(len(ln) > st.NASTALIQ_CHARS for ln in lines)
    assert _old_wrap(text, st.NASTALIQ_CHARS) is None
    # and the marks stay on their letters
    assert " ".join(lines) == text


def test_too_long_cues_still_keep_every_word():
    text = " ".join(["word"] * 40)
    lines = st.lines_for(text)
    assert len(lines) > 2 and " ".join(lines) == text


# ---------------------------------------------------------------- ASS

def test_ass_file_styles_and_events():
    long = "Hello {there} C:\\New world, a fairly long line of subtitles that wraps"
    doc = st.ass_text([(0.2, 1.5, long), (1.6, 3.25, URDU, "Ayesha, host")], 1920, 1080)
    assert "PlayResX: 1920" in doc and "PlayResY: 1080" in doc and "WrapStyle: 2" in doc
    styles = {ln.split(",")[0][7:]: ln.split(",") for ln in doc.splitlines() if ln.startswith("Style: ")}
    assert styles["Nastaliq"][1] == "Noto Nastaliq Urdu" and styles["Latin"][1] == "Noto Sans"
    assert int(styles["Nastaliq"][2]) == round(1080 * 0.062) and int(styles["Latin"][2]) == round(1080 * 0.052)
    # white text, a semi-opaque box, bottom centre, a margin of 6 % of the height
    assert styles["Latin"][3] == "&H00FFFFFF" and styles["Latin"][15] == "3" and styles["Latin"][6] == "&H60000000"
    assert styles["Latin"][18] == "2" and styles["Latin"][21] == str(round(1080 * 0.06))
    # RTL styles let libass find the base direction
    assert styles["Nastaliq"][22] == "-1" and styles["Latin"][22] == "1"
    events = [ln for ln in doc.splitlines() if ln.startswith("Dialogue: ")]
    assert events[0].startswith("Dialogue: 0,0:00:00.20,0:00:01.50,Latin,,")
    assert "\\{there\\}" in events[0] and "{there}" not in events[0].replace("\\{", "").replace("\\}", "")
    assert "C:\\\u2060New" in events[0] and events[0].count("\\N") == 1
    # logical order, untouched: no reshaping, no reversing, the speaker's comma gone from the Name field
    assert events[1].endswith(f",{URDU}") and ",Nastaliq,Ayesha  host," in events[1]


def test_ass_keeps_aerab_in_logical_order():
    doc = st.ass_text([(0, 2, ARABIC)], 1280, 720, language="ar")
    assert ARABIC in doc and "Style: Naskh,Noto Naskh Arabic," in doc


def test_filter_option_escaping():
    assert st._opt("/usr/share/fonts/truetype/noto") == "/usr/share/fonts/truetype/noto"
    # the graph parser turns \\ into \, then the option parser reads \: as a colon
    assert st._opt("C:/Fonts") == "C\\\\:/Fonts"


# ---------------------------------------------------------------- burning for real

def test_burn_latin_with_the_local_ffmpeg(tmp_path):
    src = clip(tmp_path / "src.mp4")
    dst = tmp_path / "out" / "burned.mp4"
    res = st.burn(src, dst, [(0.1, 1.9, "Hello, and welcome to the show")], language="en", width=320, height=180)
    assert res["renderer"] in ("ass", "pillow")
    info = stream_info(dst)
    assert info.has_audio and info.duration == pytest.approx(2.0, abs=0.15)
    # the subtitle box darkens the bottom of the frame
    before, after = frame(src, 1.0, tmp_path / "a.png"), frame(dst, 1.0, tmp_path / "b.png")
    band = (40, 120, 280, 170)
    assert luma(after, band) < luma(before, band) * 0.97


def test_burn_with_pillow_writes_one_overlay_track(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "subtitle_renderer", "pillow")
    src = clip(tmp_path / "src.mp4", seconds=3.0)
    dst = tmp_path / "burned.mp4"
    res = st.burn(src, dst, [(0.2, 1.2, URDU), (1.4, 2.0, ARABIC), (2.1, 2.8, URDU)], width=320, height=180)
    assert res["renderer"] == "pillow"
    assert stream_info(dst).has_audio and stream_info(dst).duration == pytest.approx(3.0, abs=0.15)
    on, off = frame(dst, 0.7, tmp_path / "on.png"), frame(dst, 1.3, tmp_path / "off.png")
    band = (0, 100, 320, 170)
    plain = luma(frame(src, 1.3, tmp_path / "src.png"), band)
    # a cue on screen, then the transparent gap between cues
    assert luma(on, band) < plain * 0.97 and luma(off, band) == pytest.approx(plain, abs=2)


def test_a_failed_libass_burn_falls_back_to_pillow(tmp_path, monkeypatch):
    def broken(*a, **kw):
        raise st.BurnError("ffmpeg failed: no fonts")

    monkeypatch.setattr(st, "_burn_ass", broken)
    monkeypatch.setattr(st, "renderer_for", lambda items: "ass")
    src = clip(tmp_path / "src.mp4")
    res = st.burn(src, tmp_path / "out.mp4", [(0.1, 1.5, ARABIC)], language="ar", width=320, height=180)
    assert res["renderer"] == "pillow" and (tmp_path / "out.mp4").is_file()


def test_no_cues_is_a_plain_copy(tmp_path):
    src = clip(tmp_path / "src.mp4")
    res = st.burn(src, tmp_path / "out.mp4", [(0, 1, "  ")])
    assert res["renderer"] == "none" and (tmp_path / "out.mp4").read_bytes() == src.read_bytes()


def test_the_renderer_choice(monkeypatch):
    urdu, latin = [st.Cue(0, 1, URDU)], [st.Cue(0, 1, "Hi")]
    monkeypatch.setattr(st, "ass_support", lambda: (True, True))
    assert st.renderer_for(urdu) == "ass"
    # an ffmpeg that can't be asked for HarfBuzz is fine for Latin, never for Urdu
    monkeypatch.setattr(st, "ass_support", lambda: (True, False))
    assert st.renderer_for(latin) == "ass" and st.renderer_for(urdu) == "pillow"
    monkeypatch.setattr(st, "ass_support", lambda: (False, False))
    assert st.renderer_for(latin) == "pillow"
    monkeypatch.setattr(st, "ass_support", lambda: (True, True))
    monkeypatch.setattr(get_settings(), "subtitle_renderer", "pillow")
    assert st.renderer_for(latin) == "pillow"


# ---------------------------------------------------------------- the Pillow cue images

def _ink_rows(img: Image.Image, top: int, bottom: int) -> tuple[int, int] | None:
    """Left and right edge of the white text between two rows."""
    xs = [x for y in range(top, bottom) for x in range(img.width)
          if img.getpixel((x, y))[:3] >= (220, 220, 220) and img.getpixel((x, y))[3] == 255]
    return (min(xs), max(xs)) if xs else None


@pytest.mark.parametrize("lang,long,short", [
    ("ur", "یہ ہمارا پہلا پروگرام ہے اور", "شکریہ"),
    ("ar", "مَرْحَبًا بِكُمْ فِي الْبَرْنَامَجِ", "شُكْرًا"),
])
def test_rtl_cue_lines_hug_the_right_of_their_box(lang, long, short):
    font = st._pil_font(None, 40)
    lh, pad = st._metrics(font)
    strip_h = lh * 2 + pad * 2
    img = st.cue_image((long, short), font, 800, strip_h, rtl=True, lang=lang)
    first, second = _ink_rows(img, pad, pad + lh), _ink_rows(img, pad + lh, strip_h - pad)
    assert first and second, "nothing drawn"
    assert second[1] - second[0] < first[1] - first[0]
    # the short line ends where the long one does: at the box's right edge
    assert abs(second[1] - first[1]) <= 6
    assert img.getbbox() is not None and img.getbbox()[2] < 800


def test_latin_cue_lines_are_centred():
    font = st._pil_font(None, 40)
    lh, pad = st._metrics(font)
    strip_h = lh * 2 + pad * 2
    img = st.cue_image(("This is the longer first line", "Short"), font, 800, strip_h, rtl=False)
    first, second = _ink_rows(img, pad, pad + lh), _ink_rows(img, pad + lh, strip_h - pad)
    assert abs((second[0] + second[1]) / 2 - 400) <= 6 and first[1] - second[1] > 40
    # the box itself is centred too
    box = img.getbbox()
    assert abs((box[0] + box[2]) / 2 - 400) <= 2


# ---------------------------------------------------------------- every feature burns through st.burn

@pytest.fixture
def fake_burn(monkeypatch):
    calls = []

    def burn(src, dst, cues, **kw):
        calls.append({"cues": list(cues), **kw})
        shutil.copyfile(src, dst)
        return {"renderer": "ass", "fonts_missing": ["Noto Nastaliq Urdu"]}

    monkeypatch.setattr(st, "burn", burn)
    return calls


def test_nothing_else_builds_a_subtitles_filter():
    from app import transcripts

    for mod in (publish, ex, transcripts):
        src = inspect.getsource(mod)
        assert "subtitles=" not in src and "force_style" not in src


def test_dub_export_burns_through_subtitles(tmp_path, fake_burn):
    src = clip(tmp_path / "src.mp4")
    work = tmp_path / "work"
    work.mkdir()
    res = ex.build_mp4(src, tmp_path / "out.mp4", [ex.Stream(None, "ur", "Original", True)], [],
                       burn=[(0.0, 1.0, URDU)], burn_language="ur", work=work)
    assert res["renderer"] == "ass"
    assert fake_burn[0]["language"] == "ur" and fake_burn[0]["cues"] == [(0.0, 1.0, URDU)]
    assert stream_info(tmp_path / "out.mp4").has_audio


def test_transcript_video_burns_through_subtitles(client, tmp_path, fast_driver, fake_burn):
    video = upload_video(client, talking_clip(tmp_path / "talk.mp4", 3.0))
    tid = client.post("/api/transcribe", json={"media_id": video["id"]}).json()["transcript_id"]
    _run_all(fast_driver)
    r = client.post(f"/api/transcripts/{tid}/video", json={"mode": "burn"})
    _run_all(fast_driver)
    with SessionLocal() as db:
        job = db.get(Job, r.json()["job"]["id"])
        assert job.status == "done", job.error
        assert job.result["subtitles"]["fonts_missing"] == ["Noto Nastaliq Urdu"]
    assert len(fake_burn) == 1 and fake_burn[0]["cues"]


def test_audiogram_burns_through_subtitles(client, tmp_path, fast_driver, fake_burn):
    ep = _produced(client, tmp_path, fast_driver, loudness="none")
    job = ok(client.post(f"/api/podcast/episodes/{ep['id']}/video", json={"aspect": "16:9", "burn_subtitles": True}),
             202)
    assert job["message"].endswith("Audiogram")
    _run_all(fast_driver)
    ep = get(client, ep)
    assert ep["jobs"]["video"]["status"] == "done", ep["jobs"]["video"]
    assert ep["outputs"]["video"]["burned"] is True
    call = fake_burn[0]
    assert (call["width"], call["height"]) == (1920, 1080) and call["language"] == ep["language"]
    assert any("Hello and welcome to the show today." in c[2] for c in call["cues"])
