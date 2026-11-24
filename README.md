# mdb-animations

---

**Level 1: The Vector Fundamentals (SVG + CSS)**
This is the easiest entry point. SVG (Scalable Vector Graphics) uses math and coordinates to draw shapes, and CSS keyframes tell the browser how to change those shapes over time. Your son can learn how code translates directly into visual geometry.

* **The Mechanics:** You define an object (like a circle or a path) in HTML, and use the `@keyframes` rule in CSS to dictate its state at different percentages of time (e.g., 0% to 100%).
* **The Project:** Open a basic text editor, paste a simple SVG (like a windmill or a ball), and apply a CSS animation to make it spin or bounce infinitely.
* **Try it:** Create an `index.html` file, add `<svg><circle cx="50" cy="50" r="40" fill="red" id="ball"/></svg>`, and write a few lines of CSS using `transform: translateY()` to make it bounce. It teaches the coordinate system and timing functions (like `ease-in-out`).

**Level 2: The Digital Flipbook (JavaScript + HTML5 Canvas)**
To build custom logic, like grabbing a photo and animating it, you move from CSS to JavaScript. The HTML `<canvas>` element is a blank slate where JS can draw and erase pixels frame-by-frame.

* **The Mechanics:** JavaScript uses a built-in function called `requestAnimationFrame()`. This acts as the "heartbeat" of the animation, telling the browser to redraw the screen 60 times per second to create the illusion of smooth movement.
* **The Project:** Use the browser's `navigator.mediaDevices.getUserMedia()` API to turn on his webcam. You can project the video stream onto a hidden `<video>` tag, use a button to "snap" a picture, and draw that specific frame onto the `<canvas>`.
* **The Animation:** Once his face is on the canvas, use variables for `X` and `Y` coordinates. In your `requestAnimationFrame` loop, add `+1` to the `X` variable every frame to make his face slide across the screen, clearing the old frame with `clearRect()` just like flipping a page.

**Level 3: Real-Time Motion Capture (JavaScript + AI Mocap)**
Your son can absolutely do motion capture directly in the browser using the webcam, no expensive suits required. This bridges traditional animation logic with modern machine learning.

* **The Mechanics:** Pre-trained AI models can scan a video feed, identify a human skeleton, and output the exact `X` and `Y` coordinates of specific body parts (eyes, nose, wrists, knees) in real-time.
* **The Project:** Use **p5.js** (a beginner-friendly JavaScript library for visual coding) combined with **ml5.js** (a machine learning library built for kids and artists). ml5.js has a built-in "PoseNet" or "BodyPose" model.
* **The Animation:** In just about 20 lines of code, the webcam turns on, the AI detects his skeleton, and he can map a digital graphic (like an SVG of a robot head or fireballs) to follow the exact coordinates of his hands and face as he dances around the room.

All of this can be written and tested for free inside browser-based code editors.
