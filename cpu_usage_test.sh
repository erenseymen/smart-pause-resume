#!/usr/bin/env bash

# Run below command to run this test:
# /usr/bin/time -p timeout 30s ./smart-pause-resume & ./cpu_usage_test.sh

sleep 1
playerctl --player="smplayer" play
sleep 1
playerctl --player="mpv" play
sleep 1
playerctl --player="mpv" pause
sleep 1
playerctl --player="smplayer" pause

sleep 1
playerctl --player="smplayer" play
sleep 1
playerctl --player="mpv" play
sleep 1
playerctl --player="mpv" pause
sleep 1
playerctl --player="smplayer" pause

sleep 1
playerctl --player="smplayer" play
sleep 1
playerctl --player="mpv" play
sleep 1
playerctl --player="mpv" pause
sleep 1
playerctl --player="smplayer" pause

sleep 1
playerctl --player="smplayer" play
sleep 1
playerctl --player="mpv" play
sleep 1
playerctl --player="mpv" pause
sleep 1
playerctl --player="smplayer" pause

sleep 1
playerctl --player="smplayer" play
sleep 1
playerctl --player="mpv" play
sleep 1
playerctl --player="mpv" pause
sleep 1
playerctl --player="smplayer" pause

sleep 1
playerctl --player="smplayer" play
sleep 1
playerctl --player="mpv" play
sleep 1
playerctl --player="mpv" pause
sleep 1
playerctl --player="smplayer" pause

sleep 1
playerctl --player="smplayer" play
sleep 1
playerctl --player="mpv" play
sleep 1
playerctl --player="mpv" pause
sleep 1
playerctl --player="smplayer" pause

