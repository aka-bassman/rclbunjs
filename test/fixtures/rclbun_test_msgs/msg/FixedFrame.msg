# A fixed-size 1 MiB frame: no strings or sequences, so middlewares can loan it.

# Frame counter.
uint64 seq
uint32 width
uint32 height
# Pixels, row by row.
uint8[1048576] data
