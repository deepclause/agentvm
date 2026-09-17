/*
 * fb-demo: a tiny bouncing-ball game for the AgentVM /dev/fb0 (simplefb).
 *
 * Build (host, riscv64 cross toolchain; static so it runs on Alpine/musl):
 *   riscv64-linux-gnu-gcc -O2 -static -o fb-demo fb-demo.c
 *
 * Run in the guest:
 *   ./fb-demo [seconds]
 *
 * It only redraws the ball's bounding box each frame, so the per-frame write
 * volume stays small even under emulation.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdint.h>
#include <time.h>
#include <sys/mman.h>

#define FB_W 1024
#define FB_H 768
#define STRIDE_PX FB_W
#define R 18

static uint32_t *fb;

static inline uint32_t rgb(int r, int g, int b) {
    /* a8r8g8b8 little-endian: bytes are B,G,R,A -> value = A<<24|R<<16|G<<8|B */
    return 0xff000000u | ((uint32_t)r << 16) | ((uint32_t)g << 8) | (uint32_t)b;
}

static inline void fill(int x, int y, int w, int h, uint32_t c) {
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > FB_W) w = FB_W - x;
    if (y + h > FB_H) h = FB_H - y;
    for (int j = 0; j < h; j++) {
        uint32_t *row = fb + (y + j) * STRIDE_PX + x;
        for (int i = 0; i < w; i++) row[i] = c;
    }
}

static inline void disc(int cx, int cy, int r, uint32_t c) {
    for (int y = -r; y <= r; y++) {
        int span = 0;
        while (span * span + y * y <= r * r) span++;
        fill(cx - span + 1, cy + y, 2 * span - 1, 1, c);
    }
}

static void msleep(long ms) {
    struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
    nanosleep(&ts, NULL);
}

int main(int argc, char **argv) {
    int seconds = (argc > 1) ? atoi(argv[1]) : 10;
    int fd = open("/dev/fb0", O_RDWR);
    if (fd < 0) { perror("open /dev/fb0"); return 1; }
    fb = mmap(NULL, (size_t)FB_W * FB_H * 4, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (fb == MAP_FAILED) { perror("mmap /dev/fb0"); return 1; }

    const uint32_t bg = rgb(16, 18, 32);
    const uint32_t border = rgb(90, 110, 200);
    const uint32_t ball = rgb(255, 210, 60);

    /* static background + border */
    fill(0, 0, FB_W, FB_H, bg);
    fill(0, 0, FB_W, 3, border);
    fill(0, FB_H - 3, FB_W, 3, border);
    fill(0, 0, 3, FB_H, border);
    fill(FB_W - 3, 0, 3, FB_H, border);

    int x = 120, y = 100, vx = 7, vy = 5;
    int oldx = x, oldy = y;
    long frames = 0;
    struct timespec t0, now;
    clock_gettime(CLOCK_MONOTONIC, &t0);

    for (;;) {
        clock_gettime(CLOCK_MONOTONIC, &now);
        double el = (now.tv_sec - t0.tv_sec) + (now.tv_nsec - t0.tv_nsec) / 1e9;
        if (el >= seconds) break;

        oldx = x; oldy = y;
        x += vx; y += vy;
        if (x < R + 3) { x = R + 3; vx = -vx; }
        if (x > FB_W - R - 3) { x = FB_W - R - 3; vx = -vx; }
        if (y < R + 3) { y = R + 3; vy = -vy; }
        if (y > FB_H - R - 3) { y = FB_H - R - 3; vy = -vy; }

        disc(oldx, oldy, R + 1, bg);       /* erase old ball */
        disc(x, y, R, ball);               /* draw new ball */
        frames++;
        msleep(16);
    }

    printf("fb-demo: %ld frames in %.1fs\n", frames, (double)seconds);
    msync(fb, (size_t)FB_W * FB_H * 4, MS_ASYNC);
    munmap(fb, (size_t)FB_W * FB_H * 4);
    close(fd);
    return 0;
}
