import { Router, type IRouter } from "express";
import conversationsRouter from "./conversations";
import previewRouter from "./preview";

const router: IRouter = Router();

router.use("/conversations", conversationsRouter);
router.use("/preview", previewRouter);

export default router;
