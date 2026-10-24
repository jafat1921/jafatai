"""Implant Preview (M22): a surgeon-only area that shows a patient a simulated breast-augmentation result.

Opt-in per account (user.implant_access) or admin. Patients, photos and results never leave this area: photos
and results are generation rows with target_type implant_photo / implant_result whose files live under
data/clinic/, and the guards in app.implant.guard keep every other route and every other job away from them.
"""
