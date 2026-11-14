// Keep the HID handle open until synchronous or asynchronous work has finished.
import { Controller } from './dualsense.js';

export async function withController(path, fn, factory = p => new Controller(p)) {
  const controller = factory(path || undefined);
  try {
    controller.open();
    return await fn(controller);
  } finally {
    controller.close();
  }
}
