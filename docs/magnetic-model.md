# Magnetic Model

PPL Navlog uses the World Magnetic Model 2025 (`WMM-2025`) for calculated magnetic variation. WMM2025 is the current five-year model, with a published validity interval from 2024-11-13 through 2029-12-31. A plan outside that interval is blocked; the application does not silently use an expired model or substitute a chart value.

## Source and license

The application embeds the degree-and-order 12 coefficients from NOAA NCEI's official `WMM.COF` distribution. The pinned WMM2025 coefficient file digest is `06791cd95faba7bdf4a709808f2715a53fe689b29c23b9886bc2196fa9b3eb13`.

The implementation is a TypeScript port of the documented NOAA reference approach: WGS84 geodetic-to-spherical conversion, Schmidt quasi-normalized associated Legendre functions, time adjustment by secular variation, and spherical harmonic synthesis. It is verified against NOAA's published WMM2025 test values. No third-party magnetic-model dependency is used.

NOAA states that WMM source code is public domain and not licensed or under copyright. This repository retains this source notice and identifies NOAA material incorporated here. The model and coefficient source are:

- [NOAA NCEI World Magnetic Model](https://www.ncei.noaa.gov/products/world-magnetic-model)
- [NOAA WMM2025 test values](https://www.ncei.noaa.gov/sites/default/files/2025-02/WMM2025_TEST_VALUES.txt)

## Calculation contract

The model accepts a validated coordinate, a UTC calculation date, and an altitude in feet MSL. It returns raw, unrounded declination in degrees with east positive, along with north/east/horizontal field intensity and provenance containing the model name, epoch, coefficient digest, validity dates, calculation date and decimal year, coordinate, and altitude.

WMM's full reference package can convert MSL altitude to WGS84 ellipsoid height through EGM96. V1 records that its MSL planning altitude is used as WGS84 ellipsoid height without that geoid correction. NOAA documents the correction as negligible for magnetic declination; this explicit assumption is retained in every model result rather than hidden.

At geographic poles, and whenever horizontal field intensity is too small to define a direction, declination is unavailable. The adapter returns an explicit error instead of manufacturing a heading correction.

For every calculated leg, PPL Navlog evaluates WMM at the great-circle midpoint of the user leg, at the selected cruise altitude and planned departure date. The midpoint is saved as the representative coordinate and shown in the calculation explanation. A pilot may use the guarded override workflow for an instructor-provided or chart-measured variation; that override preserves the computed WMM value and provenance.
