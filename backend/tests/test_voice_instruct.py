"""OmniVoice design only accepts its own attribute list; free descriptions are mapped onto it."""
import pytest

from app import voice_gallery as vg
from app.voice_instruct import VALID, normalise


@pytest.mark.parametrize("text,want,speed", [
    ("warm elderly Lahori narrator, slow, deep", "elderly, low pitch, indian accent", 0.9),
    ("Whispering teen boy", "male, teenager, whisper", 1.0),
    ("girl", "female, child", 1.0),
    ("dada ji, gentle", "male, elderly", 0.9),
    ("female news anchor, British, moderate pitch", "female, moderate pitch, british accent", 1.0),
    ("energetic young man", "male, young adult", 1.08),
])
def test_descriptions_become_omnivoice_attributes(text, want, speed):
    ins = normalise(text)
    assert ins.text == want and ins.speed == speed
    assert all(item in VALID for item in ins.understood)


def test_the_words_it_cannot_use_are_reported_not_sent():
    ins = normalise("Expressive storyteller, animated, varied pitch")
    assert ins.text is None
    assert ins.ignored == ["expressive storyteller", "animated", "varied pitch"]
    assert normalise("warm Karachi narrator").ignored == ["warm narrator"]
    # Chinese instructs have OmniVoice's own vocabulary and go through as written
    assert normalise("男，河南话").text == "男，河南话"
    assert normalise("").text is None


def test_every_gallery_omnivoice_voice_is_already_clean():
    for v in vg.catalogue().values():
        if v["engine"] == "omnivoice":
            ins = normalise(v["instruct"])
            assert ins.text == v["instruct"] and not ins.ignored, v["id"]
